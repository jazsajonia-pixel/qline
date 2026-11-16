import { Hono } from 'hono';
import { z } from 'zod';
import { decideTool, type Role } from '@qline/policy';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import { withTenant } from '../core/db';
import { ApiError, badRequest, notFound } from '../core/errors';
import { onEvents, type DomainEvent } from '../core/events';
import { body } from '../core/validate';
import { getTool, IMPLEMENTED_TOOLS } from '../agent/tools';
import { notify } from './work';
import { buildDigest, RECIPES, runAutomationStep } from '../integrations/steps';

// ---------------------------------------------------------------------------
// Definition schema (docs/08 §3, linear MVP subset)
// ---------------------------------------------------------------------------
const WORKFLOW_TOOLS = ['tasks.create', 'tasks.update', 'notes.create', 'memory.propose', 'drafts.email.create', 'contacts.update', 'contacts.create', 'calendar.create', 'forms.create', 'sheets.create'] as const;

/** Optional condition on any step: rendered with the run context; '', '0', 'false' or 'none' skips the step. */
const when = { when: z.string().max(300).optional() };

const step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('action'), ...when, tool: z.enum(WORKFLOW_TOOLS), args: z.record(z.string(), z.any()) }),
  z.object({ type: z.literal('approval'), ...when, title: z.string().min(1).max(200) }),
  z.object({ type: z.literal('notify'), ...when, title: z.string().min(1).max(200), body: z.string().max(4000).optional() }),
  // v1.2 automation steps
  z.object({ type: z.literal('ai'), ...when, prompt: z.string().min(1).max(4000), saveAs: z.string().regex(/^[a-z_]{1,30}$/) }),
  z.object({ type: z.literal('slack'), ...when, text: z.string().min(1).max(4000) }),
  z.object({ type: z.literal('email'), ...when, to: z.string().max(320), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }),
  z.object({ type: z.literal('calendar'), ...when, title: z.string().min(1).max(200), inDays: z.number().int().min(0).max(60).default(1), hourUtc: z.number().int().min(0).max(23).default(1), minutes: z.number().int().min(10).max(480).default(30) }),
]);
const STEP_LABEL: Record<string, string> = { ai: 'AI writes', slack: 'Post to Slack', email: 'Send email', calendar: 'Calendar event' };

export const definitionSchema = z.object({
  trigger: z.discriminatedUnion('type', [
    z.object({ type: z.literal('manual') }),
    z.object({ type: z.literal('event'), event: z.enum(['contact.created', 'task.created', 'import.completed', 'lead.created', 'lead.urgent', 'email.important']) }),
    z.object({ type: z.literal('schedule'), every: z.enum(['day', 'week']).default('day'), hourUtc: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6).optional().describe('0 = Sunday (UTC); only for every=week') }),
  ]),
  steps: z.array(step).min(1).max(20),
});
export type Definition = z.infer<typeof definitionSchema>;

const MAX_STEPS_PER_RUN = 50;

function render(v: unknown, ctx: Record<string, any>): any {
  if (typeof v === 'string') {
    return v.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
      const val = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), ctx);
      return val == null ? '' : String(val);
    });
  }
  if (Array.isArray(v)) return v.map((x) => render(x, ctx));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, render(x, ctx)]));
  return v;
}

export const isFalsy = (v: string) => ['', '0', 'false', 'none', 'no', 'null', 'undefined'].includes(v.trim().toLowerCase());

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
interface EngineCtx {
  orgId: string;
  workspaceId: string;
  userId: string; // workflow owner (the human it acts for)
}

export async function startWorkflowRun(e: EngineCtx, workflowId: string, trigger: { kind: string; dedupeKey?: string; data?: unknown }, dryRun = false) {
  const created = await withTenant({ orgId: e.orgId, userId: e.userId }, async (q) => {
    const wf = await q.one('select * from workflows where id=$1', [workflowId]);
    if (!wf) throw notFound('Workflow');
    if (!dryRun && (wf.status !== 'enabled' || !wf.published_version) && trigger.kind !== 'manual') return null;
    const version = dryRun ? (wf.published_version ?? 0) : wf.published_version;
    if (!dryRun && !version) throw new ApiError(409, 'WORKFLOW_NOT_PUBLISHED', 'Publish first', 'Publish the workflow before running it.');
    const r = await q.one(
      `insert into workflow_runs (org_id, workflow_id, version, trigger_kind, dedupe_key, dry_run, context, initiated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (org_id, workflow_id, dedupe_key) do nothing returning id`,
      [e.orgId, wf.id, version, trigger.kind, trigger.dedupeKey ?? null, dryRun, JSON.stringify({ trigger: trigger.data ?? {}, approved: false }), e.userId],
    );
    if (r) await audit(q, { orgId: e.orgId, actorKind: 'workflow', actorId: wf.id, action: dryRun ? 'workflow.dry_run' : 'workflow.run.started', targetRef: `workflow_run:${r.id}` });
    return r;
  });
  if (!created) return null;
  return advanceWorkflowRun(e, created.id);
}

async function loadDefinition(q: any, run: any): Promise<Definition> {
  if (run.dry_run && !run.version) {
    const wf = await q.one('select draft from workflows where id=$1', [run.workflow_id]);
    return wf.draft;
  }
  if (run.dry_run) {
    const wf = await q.one('select draft from workflows where id=$1', [run.workflow_id]);
    return wf.draft; // dry runs test the current draft
  }
  const v = await q.one('select definition from workflow_versions where workflow_id=$1 and version=$2', [run.workflow_id, run.version]);
  return v.definition;
}

export async function advanceWorkflowRun(e: EngineCtx, runId: string): Promise<any> {
  for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard++) {
    const done = await withTenant({ orgId: e.orgId, userId: e.userId }, async (q) => {
      const run = await q.one('select * from workflow_runs where id=$1 for update', [runId]);
      if (!run || run.status !== 'running') return { stop: true, run };
      const wf = await q.one('select id, name, owner_id from workflows where id=$1', [run.workflow_id]);
      const def = await loadDefinition(q, run);
      const i: number = run.current_step;
      const ctx = run.context ?? {};
      if (i >= def.steps.length) {
        await q.exec(`update workflow_runs set status='completed', ended_at=now() where id=$1`, [runId]);
        await audit(q, { orgId: e.orgId, actorKind: 'workflow', actorId: wf.id, action: 'workflow.run.completed', targetRef: `workflow_run:${runId}`, detail: { dryRun: run.dry_run } });
        return { stop: true, run: { ...run, status: 'completed' } };
      }
      const s = render(def.steps[i], ctx) as Definition['steps'][number];
      const record = (status: string, summary: string, output?: unknown) =>
        q.exec(`insert into workflow_run_steps (org_id, run_id, step_index, kind, status, summary, output) values ($1,$2,$3,$4,$5,$6,$7)`, [
          e.orgId,
          runId,
          i,
          s.type,
          status,
          summary,
          output ? JSON.stringify(output) : null,
        ]);
      const next = () => q.exec('update workflow_runs set current_step=current_step+1 where id=$1', [runId]);

      if ('when' in s && s.when !== undefined && isFalsy(s.when)) {
        await record('skipped', `Skipped: condition not met`);
        await next();
        return { stop: false };
      }

      if (s.type === 'approval') {
        if (run.dry_run) {
          await record('simulated', `Would ask for approval: ${s.title}`);
          await next();
          return { stop: false };
        }
        const remaining = def.steps.slice(i + 1).map((x: any) => render(x, ctx));
        const lines = remaining.map((x: any) =>
          x.type === 'action'
            ? (getTool(x.tool)?.preview(x.args).title ?? x.tool)
            : x.type === 'notify'
              ? `Notify: ${x.title}`
              : x.type === 'email'
                ? `Send email to ${x.to}: ${x.subject}\n${String(x.body).slice(0, 600)}`
                : x.type === 'slack'
                  ? `Post to Slack: ${String(x.text).slice(0, 200)}`
                  : x.type === 'calendar'
                    ? `Calendar: ${x.title} in ${x.inDays} day(s)`
                    : (x.title ?? STEP_LABEL[x.type] ?? x.type),
        );
        const tc = await q.one(
          `insert into tool_calls (org_id, workflow_run_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,'workflow.approval',$3,'L1','require_approval',$4,'waiting_approval') returning id`,
          [e.orgId, runId, JSON.stringify({ step: i }), `wf:${runId}:${i}`],
        );
        const a = await q.one(
          `insert into approval_requests (org_id, workspace_id, requester_kind, requester_id, requested_for, tool_call_id, action, preview, risk, reason, expires_at)
           values ($1,$2,'workflow',$3,$4,$5,'workflow.continue',$6,'L1','Workflow approval step', now() + interval '72 hours') returning id`,
          [e.orgId, e.workspaceId, wf.id, wf.owner_id, tc.id, JSON.stringify({ title: s.title, lines, workflow: wf.name, runId })],
        );
        await q.exec(`update workflow_runs set status='waiting_approval' where id=$1`, [runId]);
        await record('waiting_approval', s.title, { approvalId: a.id });
        await notify(q, e.orgId, wf.owner_id, { category: 'approval', title: `Approval needed: ${s.title}`, ref: { type: 'approval', id: a.id } });
        return { stop: true, run: { ...run, status: 'waiting_approval' }, approvalId: a.id };
      }

      if (s.type === 'notify') {
        if (run.dry_run) await record('simulated', `Would notify: ${s.title}`);
        else {
          await notify(q, e.orgId, wf.owner_id, { category: 'workflow', title: s.title, body: s.body, ref: { type: 'workflow_run', id: runId } });
          await record('succeeded', `Notified: ${s.title}`);
        }
        await next();
        return { stop: false };
      }

      if (s.type === 'ai' || s.type === 'slack' || s.type === 'email' || s.type === 'calendar') {
        if (run.dry_run) {
          if (s.type === 'ai') await q.exec(`update workflow_runs set context = context || jsonb_build_object($2::text, $3::text) where id=$1`, [runId, s.saveAs, '(AI text would appear here)']);
          await record('simulated', `Would ${STEP_LABEL[s.type]!.toLowerCase()}${s.type === 'email' ? ` to ${s.to}` : ''}`);
          await next();
          return { stop: false };
        }
        if (s.type === 'email' && !ctx.approved) {
          await record('failed', 'Sending email needs an approval step before it.');
          await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, 'Missing approval step']);
          return { stop: true, run: { ...run, status: 'failed' } };
        }
        const r = await runAutomationStep(q, { orgId: e.orgId, workspaceId: e.workspaceId, ownerId: wf.owner_id, runId }, s);
        if (s.type === 'ai' && r.ok && r.text != null) await q.exec(`update workflow_runs set context = context || jsonb_build_object($2::text, $3::text) where id=$1`, [runId, s.saveAs, r.text]);
        await record(r.ok ? (r.skipped ? 'skipped' : 'succeeded') : 'failed', r.summary);
        if (!r.ok) {
          await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, r.summary]);
          await notify(q, e.orgId, wf.owner_id, { category: 'workflow', title: `Workflow "${wf.name}" stopped`, body: r.summary });
          return { stop: true, run: { ...run, status: 'failed' } };
        }
        await next();
        return { stop: false };
      }

      // action
      const tool = getTool(s.tool);
      const member = await q.one('select role from organization_members where org_id=$1 and user_id=$2 and status=$3', [e.orgId, wf.owner_id, 'active']);
      const decision = decideTool({ tool: s.tool, allowlist: IMPLEMENTED_TOOLS as string[], userRole: (member?.role ?? 'viewer') as Role });
      const parsed = tool?.schema.safeParse(s.args);
      if (!tool || !parsed?.success) {
        await record('failed', `Invalid step: ${s.tool}`);
        await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, 'Invalid step arguments']);
        return { stop: true, run: { ...run, status: 'failed' } };
      }
      if (run.dry_run) {
        await record('simulated', `Would run: ${tool.preview(parsed.data).title}`, { decision: decision.decision });
        await next();
        return { stop: false };
      }
      if (decision.decision === 'deny') {
        await record('failed', `Not allowed: ${decision.reason}`);
        await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, decision.reason]);
        await notify(q, e.orgId, wf.owner_id, { category: 'workflow', title: `Workflow "${wf.name}" stopped`, body: decision.reason });
        return { stop: true, run: { ...run, status: 'failed' } };
      }
      if (decision.decision === 'require_approval' && !ctx.approved) {
        await record('failed', 'This action needs an approval step before it.');
        await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, 'Missing approval step']);
        return { stop: true, run: { ...run, status: 'failed' } };
      }
      const tc = await q.one(
        `insert into tool_calls (org_id, workflow_run_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,$3,$4,$5,$6,$7,'planned')
         on conflict (org_id, idempotency_key) do nothing returning id`,
        [e.orgId, runId, s.tool, JSON.stringify(parsed.data), decision.risk, decision.decision, `wf:${runId}:${i}`],
      );
      if (!tc) {
        await next();
        return { stop: false }; // already executed (idempotent)
      }
      const r = await tool.execute(q, { orgId: e.orgId, workspaceId: e.workspaceId, userId: wf.owner_id, actor: { kind: 'workflow', id: wf.id } }, parsed.data);
      await q.exec(`update tool_calls set status=$2, result_summary=$3, result_refs=$4, finished_at=now() where id=$1`, [tc.id, r.ok ? 'succeeded' : 'failed', r.summary, JSON.stringify(r.refs)]);
      await record(r.ok ? 'succeeded' : 'failed', r.summary, { refs: r.refs });
      if (!r.ok) {
        await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, r.summary]);
        return { stop: true, run: { ...run, status: 'failed' } };
      }
      await next();
      return { stop: false };
    });
    if (done.stop) return getRunDetail(e, runId);
  }
  await withTenant({ orgId: e.orgId, userId: e.userId }, (q) => q.exec(`update workflow_runs set status='failed', error='Step limit reached', ended_at=now() where id=$1`, [runId]));
  return getRunDetail(e, runId);
}

async function getRunDetail(e: EngineCtx, runId: string) {
  return withTenant({ orgId: e.orgId, userId: e.userId }, async (q) => {
    const run = await q.one('select * from workflow_runs where id=$1', [runId]);
    const steps = await q.many('select step_index, kind, status, summary, output, created_at from workflow_run_steps where run_id=$1 order by created_at', [runId]);
    return { ...run, steps };
  });
}

export async function resumeWorkflowAfterDecision(t: TenantCtx, approval: any, decision: 'approve' | 'reject') {
  const runId = approval.preview?.runId;
  const e = { orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId };
  await withTenant({ orgId: t.orgId, userId: t.userId }, async (q) => {
    await q.exec(`update tool_calls set status=$2, finished_at=now() where id=$1`, [approval.tool_call_id, decision === 'approve' ? 'succeeded' : 'rejected']);
    if (decision === 'approve') {
      await q.exec(`update workflow_runs set status='running', current_step=current_step+1, context = context || '{"approved": true}'::jsonb where id=$1 and status='waiting_approval'`, [runId]);
      await q.exec(`update approval_requests set status='executed' where id=$1`, [approval.id]);
    } else {
      await q.exec(`update workflow_runs set status='rejected', ended_at=now() where id=$1 and status='waiting_approval'`, [runId]);
    }
  });
  if (decision === 'reject') return getRunDetail(e, runId);
  return advanceWorkflowRun(e, runId);
}

/** Event triggers: run enabled workflows subscribed to these events. */
onEvents(async (t, events) => {
  for (const ev of events) {
    const wfs = await tx(t, (q) =>
      q.many(
        `select w.id, w.owner_id from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.published_version
         where w.status='enabled' and v.definition->'trigger'->>'type'='event' and v.definition->'trigger'->>'event'=$1`,
        [ev.type],
      ),
    );
    for (const wf of wfs) {
      await startWorkflowRun({ orgId: t.orgId, workspaceId: t.workspaceId, userId: wf.owner_id }, wf.id, { kind: `event:${ev.type}`, dedupeKey: ev.id, data: ev.data });
    }
  }
});

/** Cron tick (Neon Function Trigger). */
export async function runScheduledWorkflows(): Promise<{ started: number }> {
  const due = await withTenant({ orgId: null, userId: 'system:scheduler' }, (q) => q.many('select * from qline_due_schedules()'));
  let started = 0;
  for (const d of due) {
    const ws = await withTenant({ orgId: d.org_id, userId: d.owner_id }, async (q) => {
      await q.exec('update workflows set last_scheduled_at=now() where id=$1', [d.workflow_id]);
      return q.one('select workspace_id from workflows where id=$1', [d.workflow_id]);
    });
    const day = new Date().toISOString().slice(0, 10);
    const trig = await withTenant({ orgId: d.org_id, userId: d.owner_id }, (q) =>
      q.one(`select v.definition->'trigger' as t from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.published_version where w.id=$1`, [d.workflow_id]),
    );
    if (trig?.t?.every === 'week' && trig.t.weekday != null && new Date().getUTCDay() !== Number(trig.t.weekday)) continue; // not this weekday
    const digest = await withTenant({ orgId: d.org_id, userId: d.owner_id }, (q) => buildDigest(q));
    await startWorkflowRun({ orgId: d.org_id, workspaceId: ws.workspace_id, userId: d.owner_id }, d.workflow_id, { kind: 'schedule', dedupeKey: `schedule:${day}`, data: { date: day, ...digest } });
    started += 1;
  }
  return { started };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const workflowRoutes = new Hono<Env>();

workflowRoutes.get('/workflows', async (c) => {
  const t = need(c, 'workflows.read');
  const items = await tx(t, (q) =>
    q.many(
      `select w.*, (select count(*)::int from workflow_runs r where r.workflow_id=w.id) as run_count,
              (select max(started_at) from workflow_runs r where r.workflow_id=w.id) as last_run_at
       from workflows w order by w.created_at desc`,
    ),
  );
  return c.json({ items });
});

workflowRoutes.post('/workflows', async (c) => {
  const t = need(c, 'workflows.manage');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(), definition: definitionSchema }));
  const row = await tx(t, async (q) => {
    const r = await q.one(`insert into workflows (org_id, workspace_id, name, description, draft, owner_id) values ($1,$2,$3,$4,$5,$6) returning *`, [
      t.orgId,
      t.workspaceId,
      input.name,
      input.description ?? null,
      JSON.stringify(input.definition),
      t.userId,
    ]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'workflow.created', targetRef: `workflow:${r.id}` });
    return r;
  });
  return c.json(row, 201);
});

workflowRoutes.get('/workflows/:id', async (c) => {
  const t = need(c, 'workflows.read');
  const data = await tx(t, async (q) => {
    const w = await q.one('select * from workflows where id=$1', [c.req.param('id')]);
    if (!w) throw notFound('Workflow');
    const versions = await q.many('select version, created_at, created_by from workflow_versions where workflow_id=$1 order by version desc', [w.id]);
    const runs = await q.many('select id, status, trigger_kind, dry_run, started_at, ended_at, error from workflow_runs where workflow_id=$1 order by started_at desc limit 20', [w.id]);
    return { ...w, versions, runs };
  });
  return c.json(data);
});

workflowRoutes.put('/workflows/:id', async (c) => {
  const t = need(c, 'workflows.manage');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(1000).optional(), definition: definitionSchema.optional() }));
  const row = await tx(t, async (q) => {
    const r = await q.one(`update workflows set name=coalesce($2,name), description=coalesce($3,description), draft=coalesce($4,draft), updated_at=now() where id=$1 returning *`, [
      c.req.param('id'),
      input.name ?? null,
      input.description ?? null,
      input.definition ? JSON.stringify(input.definition) : null,
    ]);
    if (!r) throw notFound('Workflow');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'workflow.edited', targetRef: `workflow:${r.id}` });
    return r;
  });
  return c.json(row);
});

workflowRoutes.post('/workflows/:id/publish', async (c) => {
  const t = need(c, 'workflows.manage');
  const row = await tx(t, async (q) => {
    const w = await q.one('select * from workflows where id=$1 for update', [c.req.param('id')]);
    if (!w) throw notFound('Workflow');
    const parsed = definitionSchema.safeParse(w.draft);
    if (!parsed.success) throw badRequest('The draft is not a valid workflow.');
    // Policy check at publish: actions needing approval must be preceded by an approval step.
    let approved = false;
    for (const s of parsed.data.steps) {
      if (s.type === 'approval') approved = true;
      if (s.type === 'email' && !approved) throw badRequest('Sending email needs an approval step before it.');
      if (s.type === 'action') {
        const d = decideTool({ tool: s.tool, allowlist: IMPLEMENTED_TOOLS as string[], userRole: t.role });
        if (d.decision === 'deny') throw badRequest(`${s.tool}: ${d.reason}`);
        if (d.decision === 'require_approval' && !approved) throw badRequest(`${s.tool} needs an approval step before it.`);
      }
    }
    const version = (w.published_version ?? 0) + 1;
    await q.exec(`insert into workflow_versions (org_id, workflow_id, version, definition, created_by) values ($1,$2,$3,$4,$5)`, [t.orgId, w.id, version, JSON.stringify(parsed.data), t.userId]);
    const r = await q.one(`update workflows set published_version=$2, updated_at=now() where id=$1 returning *`, [w.id, version]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'workflow.published', targetRef: `workflow:${w.id}`, detail: { version } });
    return r;
  });
  return c.json(row);
});

for (const action of ['enable', 'disable'] as const) {
  workflowRoutes.post(`/workflows/:id/${action}`, async (c) => {
    const t = need(c, 'workflows.manage');
    const row = await tx(t, async (q) => {
      const w = await q.one('select * from workflows where id=$1', [c.req.param('id')]);
      if (!w) throw notFound('Workflow');
      if (action === 'enable' && !w.published_version) throw new ApiError(409, 'WORKFLOW_NOT_PUBLISHED', 'Publish first', 'Publish the workflow before enabling it.');
      const r = await q.one(`update workflows set status=$2, updated_at=now() where id=$1 returning *`, [w.id, action === 'enable' ? 'enabled' : 'disabled']);
      await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: `workflow.${action}d`, targetRef: `workflow:${w.id}` });
      return r;
    });
    return c.json(row);
  });
}

workflowRoutes.post('/workflows/:id/run', async (c) => {
  const t = need(c, 'workflows.manage');
  const input = await body(c, z.object({ data: z.record(z.string(), z.any()).optional() }));
  const run = await startWorkflowRun({ orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId }, c.req.param('id'), { kind: 'manual', data: input.data ?? {} });
  return c.json(run, 201);
});

workflowRoutes.post('/workflows/:id/dry-run', async (c) => {
  const t = need(c, 'workflows.read');
  const input = await body(c, z.object({ data: z.record(z.string(), z.any()).optional() }));
  const run = await startWorkflowRun({ orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId }, c.req.param('id'), { kind: 'manual', data: input.data ?? { name: 'Sample Client' } }, true);
  return c.json({ ...run, label: 'Dry run — nothing was changed' }, 201);
});

workflowRoutes.get('/workflow-runs/:id', async (c) => {
  const t = need(c, 'workflows.read');
  const exists = await tx(t, (q) => q.one('select id from workflow_runs where id=$1', [c.req.param('id')]));
  if (!exists) throw notFound('Workflow run');
  return c.json(await getRunDetail({ orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId }, c.req.param('id')));
});

workflowRoutes.get('/workflow-recipes', async (c) => {
  const t = need(c, 'workflows.read');
  const have = await tx(t, (q) => q.many('select name from workflows'));
  const names = new Set(have.map((r: any) => r.name));
  return c.json({ items: RECIPES.map((r) => ({ id: r.id, name: r.name, description: r.description, needs: r.needs, installed: names.has(r.name), steps: r.definition.steps.length })) });
});

/** Installs a ready-made automation: creates, publishes and enables it in one go. */
workflowRoutes.post('/workflow-recipes/:id/install', async (c) => {
  const t = need(c, 'workflows.manage');
  const r = RECIPES.find((x) => x.id === c.req.param('id'));
  if (!r) throw notFound('Recipe');
  const def = definitionSchema.parse(r.definition);
  const row = await tx(t, async (q) => {
    const exists = await q.one('select id from workflows where name=$1', [r.name]);
    if (exists) throw new ApiError(409, 'ALREADY_INSTALLED', `${r.name} is already set up`, 'Find it in Workflows.');
    const w = await q.one(`insert into workflows (org_id, workspace_id, name, description, draft, owner_id, published_version, status) values ($1,$2,$3,$4,$5,$6,1,'enabled') returning *`, [
      t.orgId,
      t.workspaceId,
      r.name,
      r.description,
      JSON.stringify(def),
      t.userId,
    ]);
    await q.exec(`insert into workflow_versions (org_id, workflow_id, version, definition, created_by) values ($1,$2,1,$3,$4)`, [t.orgId, w.id, JSON.stringify(def), t.userId]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'workflow.installed', targetRef: `workflow:${w.id}`, detail: { recipe: r.id } });
    return w;
  });
  return c.json(row, 201);
});

export type { DomainEvent };
