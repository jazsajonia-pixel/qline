import { Hono } from 'hono';
import { z } from 'zod';
import { can, decideTool, TOOL_POLICIES, type Role } from '@qline/policy';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import { withTenant, type Q } from '../core/db';
import { ApiError, badRequest, notFound } from '../core/errors';
import { onEvents, type DomainEvent } from '../core/events';
import { body, limitParam, query } from '../core/validate';
import { getTool, IMPLEMENTED_TOOLS } from '../agent/tools';
import { notify } from './work';
import { buildDigest, RECIPES, runAutomationStep } from '../integrations/steps';
import { enqueue, kick, registerJob, runInline, type JobCtx } from '../runtime/jobs';

// ---------------------------------------------------------------------------
// Definition schema (docs/08 §3, linear MVP subset)
// ---------------------------------------------------------------------------
const WORKFLOW_TOOLS = ['tasks.create', 'tasks.update', 'notes.create', 'memory.propose', 'drafts.email.create', 'contacts.update', 'contacts.create', 'calendar.create', 'forms.create', 'sheets.create'] as const;

/** Optional condition on any step: rendered with the run context; '', '0', 'false' or 'none' skips the step. */
const when = { when: z.string().max(300).optional() };
/** Run-context keys the engine owns. An AI step may not overwrite them (e.g. saveAs "approved" would forge an approval). */
export const RESERVED_CONTEXT_KEYS = new Set(['approved', 'approved_steps', 'trigger']);

const step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('action'), ...when, tool: z.enum(WORKFLOW_TOOLS), args: z.record(z.string(), z.any()) }),
  z.object({ type: z.literal('approval'), ...when, title: z.string().min(1).max(200) }),
  z.object({ type: z.literal('notify'), ...when, title: z.string().min(1).max(200), body: z.string().max(4000).optional() }),
  // v1.2 automation steps
  z.object({ type: z.literal('ai'), ...when, prompt: z.string().min(1).max(4000), saveAs: z.string().regex(/^[a-z_]{1,30}$/).refine((v) => !RESERVED_CONTEXT_KEYS.has(v), 'This name is reserved') }),
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

/** Enqueues the job that advances a run (inside the caller's transaction). */
export async function enqueueAdvance(q: Q, e: EngineCtx, runId: string, reason: string) {
  return enqueue(q, {
    orgId: e.orgId,
    kind: 'workflow.advance',
    payload: { runId, workspaceId: e.workspaceId, userId: e.userId },
    idempotencyKey: `run:${runId}:${reason}`,
    createdBy: e.userId,
    maxAttempts: 5,
  });
}

/**
 * Creates a run and its advance job in one transaction (durable from that point).
 * mode 'inline' runs the job in this request (manual runs keep their instant response);
 * 'queue' leaves it to workers (event/schedule triggers already run inside a worker).
 */
export async function startWorkflowRun(e: EngineCtx, workflowId: string, trigger: { kind: string; dedupeKey?: string; data?: unknown }, dryRun = false, mode: 'inline' | 'queue' = 'inline') {
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
    if (!r) return null;
    await audit(q, { orgId: e.orgId, actorKind: 'workflow', actorId: wf.id, action: dryRun ? 'workflow.dry_run' : 'workflow.run.started', targetRef: `workflow_run:${r.id}` });
    const job = await enqueueAdvance(q, e, r.id, 'start');
    return { id: r.id as string, jobId: job.id };
  });
  if (!created) return null;
  if (mode === 'inline') await runInline(created.jobId);
  return getRunDetail(e, created.id);
}

const EXTERNAL_TOOL: Record<string, string> = { email: 'email.send', slack: 'slack.post', calendar: 'calendar.create' };

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

type StepOutcome = { stop: boolean; run?: any; approvalId?: string; external?: { tcId: string; index: number; step: any; ownerId: string; wfName: string } };

/** Runs steps until the run stops. Called only from the `workflow.advance` job (one worker per run at a time). */
export async function advanceWorkflowRun(e: EngineCtx, runId: string, job?: JobCtx): Promise<any> {
  for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard++) {
    if (job && guard > 0) await job.heartbeat(); // extends the lease; throws when cancelled or fenced out
    const done: StepOutcome = await withTenant({ orgId: e.orgId, userId: e.userId }, async (q): Promise<StepOutcome> => {
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
        if (s.type === 'slack' && ctx.approved !== true && ctx.approved_steps?.[String(i)] !== true) {
          // Slack posts need a human decision, like assistant-initiated posts (policy: slack.post is L3 require_approval).
          // New versions must have an approval step before Slack (checked at publish). Versions published before this
          // rule get an approval for this exact post instead of posting freely. Idempotent per run+step.
          const intent = await q.one('select 1 from tool_calls where idempotency_key=$1', [`wf:${runId}:${i}`]);
          // An intent recorded before this rule falls through: the idempotency logic below reuses or flags it and never posts again.
          if (!intent) {
            const gateKey = `wf:${runId}:${i}:gate`;
            const prior = await q.one(`select tc.id, a.id as approval_id, a.status from tool_calls tc left join approval_requests a on a.tool_call_id = tc.id where tc.idempotency_key=$1`, [gateKey]);
            if (prior && prior.status !== 'pending') {
              // Decided or expired without approving this step: never post.
              await record('failed', 'Posting to Slack was not approved.');
              await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, 'Slack post not approved']);
              return { stop: true, run: { ...run, status: 'failed' } };
            }
            let approvalId = prior?.approval_id;
            if (!prior) {
              const tc = await q.one(
                `insert into tool_calls (org_id, workflow_run_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,'workflow.approval',$3,'L1','require_approval',$4,'waiting_approval') returning id`,
                [e.orgId, runId, JSON.stringify({ step: i, gate: 'slack' }), gateKey],
              );
              const a = await q.one(
                `insert into approval_requests (org_id, workspace_id, requester_kind, requester_id, requested_for, tool_call_id, action, preview, risk, reason, expires_at)
                 values ($1,$2,'workflow',$3,$4,$5,'workflow.continue',$6,'L1','Slack posts need approval', now() + interval '72 hours') returning id`,
                [e.orgId, e.workspaceId, wf.id, wf.owner_id, tc.id, JSON.stringify({ title: 'Post this to Slack?', lines: [`Post to Slack: ${String(s.text).slice(0, 600)}`], workflow: wf.name, runId, gateStep: i })],
              );
              approvalId = a.id;
              await notify(q, e.orgId, wf.owner_id, { category: 'approval', title: `Approval needed: post to Slack (${wf.name})`, ref: { type: 'approval', id: a.id } });
            }
            await q.exec(`update workflow_runs set status='waiting_approval' where id=$1`, [runId]);
            await record('waiting_approval', 'Waiting for approval to post to Slack', { approvalId });
            return { stop: true, run: { ...run, status: 'waiting_approval' }, approvalId };
          }
        }
        if (s.type === 'email' && ctx.approved !== true) {
          await record('failed', 'Sending email needs an approval step before it.');
          await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, 'Missing approval step']);
          return { stop: true, run: { ...run, status: 'failed' } };
        }
        if (s.type !== 'ai') {
          // External side effect: record the intent and commit BEFORE calling the provider (docs/12 §7).
          const key = `wf:${runId}:${i}`;
          const prior = await q.one('select id, status, result_summary from tool_calls where idempotency_key=$1', [key]);
          if (prior?.status === 'succeeded' || prior?.status === 'failed') {
            // Result was recorded but the step did not advance (crash in between): reuse it, never resend.
            await record(prior.status, prior.result_summary ?? `${STEP_LABEL[s.type]} already done`);
            if (prior.status === 'failed') {
              await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1`, [runId, prior.result_summary ?? 'External step failed']);
              return { stop: true, run: { ...run, status: 'failed' } };
            }
            await next();
            return { stop: false };
          }
          if (prior?.status === 'executing' || prior?.status === 'unknown') {
            // A previous attempt may have sent it. Never send twice: a person decides.
            await q.exec(`update tool_calls set status='unknown', result_summary='Outcome unknown after an interrupted attempt', finished_at=now() where id=$1`, [prior.id]);
            await record('unknown', `${STEP_LABEL[s.type]}: the previous attempt was interrupted, so it may or may not have happened. Not retried.`);
            await q.exec(`update workflow_runs set status='needs_attention', error=$2 where id=$1`, [runId, 'Outcome of an external step is unknown']);
            await notify(q, e.orgId, wf.owner_id, { category: 'workflow', title: `Check workflow "${wf.name}"`, body: `${STEP_LABEL[s.type]} was interrupted. Check whether it happened, then re-run if needed.`, ref: { type: 'workflow_run', id: runId } });
            return { stop: true, run: { ...run, status: 'needs_attention' } };
          }
          const tool = EXTERNAL_TOOL[s.type]!;
          const tc = await q.one(
            `insert into tool_calls (org_id, workflow_run_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,$3,$4,$5,$6,$7,'executing') returning id`,
            [e.orgId, runId, tool, JSON.stringify(s), TOOL_POLICIES[tool]?.risk ?? 'L2', s.type === 'email' || s.type === 'slack' ? 'require_approval' : 'allow', key],
          );
          return { stop: false, external: { tcId: tc.id, index: i, step: s, ownerId: wf.owner_id, wfName: wf.name } };
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
      if (decision.decision === 'require_approval' && ctx.approved !== true) {
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
    if (done.external) await finishExternalStep(e, runId, done.external, job);
    else if (done.stop) return getRunDetail(e, runId);
  }
  await withTenant({ orgId: e.orgId, userId: e.userId }, (q) => q.exec(`update workflow_runs set status='failed', error='Step limit reached', ended_at=now() where id=$1`, [runId]));
  return getRunDetail(e, runId);
}

/** Calls the provider outside the run lock, then records the result and moves on, all fenced by the job lease. */
async function finishExternalStep(e: EngineCtx, runId: string, x: NonNullable<StepOutcome['external']>, job?: JobCtx) {
  const r = await withTenant({ orgId: e.orgId, userId: e.userId }, (q) => runAutomationStep(q, { orgId: e.orgId, workspaceId: e.workspaceId, ownerId: x.ownerId, runId }, x.step));
  // Always record what happened, even if this worker was fenced out meanwhile (a person may be checking it).
  await withTenant({ orgId: e.orgId, userId: e.userId }, async (q) => {
    const run = await q.one('select status, current_step from workflow_runs where id=$1 for update', [runId]);
    await q.exec(`update tool_calls set status=$2, result_summary=$3, finished_at=now() where id=$1`, [x.tcId, r.ok ? 'succeeded' : r.unknown ? 'unknown' : 'failed', r.summary]);
    if (!run || run.status !== 'running' || run.current_step !== x.index) return;
    await q.exec(`insert into workflow_run_steps (org_id, run_id, step_index, kind, status, summary) values ($1,$2,$3,$4,$5,$6)`, [
      e.orgId,
      runId,
      x.index,
      x.step.type,
      r.ok ? (r.skipped ? 'skipped' : 'succeeded') : r.unknown ? 'unknown' : 'failed',
      r.summary,
    ]);
    if (!r.ok && r.unknown) {
      // The provider may have done it (timeout, network error, 5xx after sending). A person checks; never resent.
      await q.exec(`update workflow_runs set status='needs_attention', error=$2 where id=$1 and status='running'`, [runId, r.summary]);
      await notify(q, e.orgId, x.ownerId, { category: 'workflow', title: `Check workflow "${x.wfName}"`, body: `${r.summary}. Check whether it happened before re-running.`, ref: { type: 'workflow_run', id: runId } });
      return;
    }
    if (!r.ok) {
      await q.exec(`update workflow_runs set status='failed', error=$2, ended_at=now() where id=$1 and status='running'`, [runId, r.summary]);
      await notify(q, e.orgId, x.ownerId, { category: 'workflow', title: `Workflow "${x.wfName}" stopped`, body: r.summary });
      return;
    }
    await q.exec('update workflow_runs set current_step=current_step+1 where id=$1', [runId]);
  });
}

async function getRunDetail(e: EngineCtx, runId: string) {
  return withTenant({ orgId: e.orgId, userId: e.userId }, async (q) => {
    const run = await q.one('select * from workflow_runs where id=$1', [runId]);
    const steps = await q.many('select step_index, kind, status, summary, output, created_at from workflow_run_steps where run_id=$1 order by created_at', [runId]);
    return { ...run, steps };
  });
}

/**
 * Applies a human decision to a parked run inside the approval transaction (atomic with the decision),
 * and enqueues the resume job only when approved. A rejected or expired approval never enqueues anything.
 */
export async function applyWorkflowDecision(q: Q, t: TenantCtx, approval: any, decision: 'approve' | 'reject') {
  const runId = approval.preview?.runId;
  await q.exec(`update tool_calls set status=$2, finished_at=now() where id=$1`, [approval.tool_call_id, decision === 'approve' ? 'succeeded' : 'rejected']);
  if (decision === 'reject') {
    await q.exec(`update workflow_runs set status='rejected', ended_at=now() where id=$1 and status='waiting_approval'`, [runId]);
    return { runId, jobId: null as string | null };
  }
  // An approval step approves the steps after it (and moves past itself). A per-step gate (a Slack post in a version
  // published before the Slack rule) approves only that step, which then runs.
  const gateStep = approval.preview?.gateStep;
  const n =
    gateStep != null
      ? await q.exec(
          `update workflow_runs set status='running', context = jsonb_set(context || jsonb_build_object('approved_steps', coalesce(context->'approved_steps', '{}'::jsonb)), array['approved_steps', $2::text], 'true'::jsonb) where id=$1 and status='waiting_approval' and current_step=$3`,
          [runId, String(gateStep), Number(gateStep)],
        )
      : await q.exec(`update workflow_runs set status='running', current_step=current_step+1, context = context || '{"approved": true}'::jsonb where id=$1 and status='waiting_approval'`, [runId]);
  await q.exec(`update approval_requests set status='executed' where id=$1`, [approval.id]);
  if (!n) return { runId, jobId: null };
  const run = await q.one('select initiated_by, workflow_id from workflow_runs where id=$1', [runId]);
  const wf = await q.one('select owner_id, workspace_id from workflows where id=$1', [run.workflow_id]);
  const job = await enqueueAdvance(q, { orgId: t.orgId, workspaceId: wf.workspace_id, userId: wf.owner_id }, runId, `approval:${approval.id}`);
  return { runId, jobId: job.id as string | null };
}

export async function resumeWorkflowAfterDecision(t: TenantCtx, applied: { runId: string; jobId: string | null }) {
  if (applied.jobId) await runInline(applied.jobId);
  return getRunDetail({ orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId }, applied.runId);
}

/** Cancels a run: it stops at the next step boundary; steps already done stay done. */
export async function cancelWorkflowRun(t: TenantCtx, runId: string) {
  return tx(t, async (q) => {
    const run = await q.one('select id, status from workflow_runs where id=$1 for update', [runId]);
    if (!run) throw notFound('Workflow run');
    if (!['queued', 'running', 'waiting_approval', 'needs_attention'].includes(run.status)) throw new ApiError(409, 'RUN_FINISHED', 'Already finished', `This run is ${run.status}.`);
    await q.exec(`update workflow_runs set status='cancelled', error='Cancelled by a person', ended_at=now() where id=$1`, [runId]);
    await q.exec(`update approval_requests set status='expired' where status='pending' and preview->>'runId' = $1`, [runId]);
    await q.exec(`update jobs set cancel_requested=true, updated_at=now() where kind='workflow.advance' and payload->>'runId'=$1 and status in ('queued','running')`, [runId]);
    await q.exec(`update jobs set status='cancelled', finished_at=now() where kind='workflow.advance' and payload->>'runId'=$1 and status='queued'`, [runId]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'workflow.run.cancelled', targetRef: `workflow_run:${runId}` });
    return { id: runId, status: 'cancelled' };
  });
}

/**
 * Lets a person settle a run that needs attention (docs/12 §7, M5):
 *  - an external step with an unknown outcome: 'happened' records it as done and moves on; 'not_happened'
 *    voids the old intent so the step runs again (a person decided to resend);
 *  - a run that stopped for another reason (e.g. retries exhausted): 'retry' resumes it from the same step.
 * The engine re-checks approval gates on resume; nothing here can approve a step that was not approved.
 */
export async function resolveWorkflowRun(t: TenantCtx, runId: string, outcome: 'happened' | 'not_happened' | 'retry') {
  if (!t.human) throw new ApiError(403, 'FORBIDDEN', 'Only a person can decide this');
  const out = await tx(t, async (q) => {
    const run = await q.one('select r.*, w.owner_id, w.workspace_id as wf_workspace from workflow_runs r join workflows w on w.id=r.workflow_id where r.id=$1 for update of r', [runId]);
    if (!run) throw notFound('Workflow run');
    if (run.status !== 'needs_attention') throw new ApiError(409, 'RUN_NOT_STUCK', 'Nothing to resolve', `This run is ${run.status.replace('_', ' ')}.`);
    const key = `wf:${runId}:${run.current_step}`;
    const tc = await q.one(`select id, tool from tool_calls where idempotency_key=$1 and status in ('unknown','executing')`, [key]);
    const rec = (status: string, summary: string) =>
      q.exec(`insert into workflow_run_steps (org_id, run_id, step_index, kind, status, summary) values ($1,$2,$3,'resolution',$4,$5)`, [t.orgId, runId, run.current_step, status, summary]);
    if (tc) {
      if (outcome === 'retry') throw new ApiError(409, 'OUTCOME_UNKNOWN', 'Check first', 'This step may already have happened. Say whether it did before continuing.');
      if (outcome === 'happened') {
        await q.exec(`update tool_calls set status='succeeded', result_summary='Confirmed by a person: it happened', finished_at=now() where id=$1`, [tc.id]);
        await rec('succeeded', 'A person confirmed it happened');
        await q.exec('update workflow_runs set current_step=current_step+1 where id=$1', [runId]);
      } else {
        await q.exec(`update tool_calls set status='failed', idempotency_key=idempotency_key || ':void:' || id::text, result_summary='Confirmed by a person: it did not happen', finished_at=now() where id=$1`, [tc.id]);
        await rec('skipped', 'A person confirmed it did not happen; running the step again');
      }
    } else {
      if (outcome !== 'retry') throw new ApiError(409, 'NOTHING_TO_CONFIRM', 'Nothing to confirm', 'No step is waiting for a check. Use Retry to continue.');
      await rec('skipped', 'A person asked to continue from this step');
    }
    await q.exec(`update workflow_runs set status='running', error=null, ended_at=null where id=$1`, [runId]);
    const job = await enqueueAdvance(q, { orgId: t.orgId, workspaceId: run.wf_workspace, userId: run.owner_id }, runId, `resolve:${outcome}:${Date.now()}`);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'workflow.run.resolved', targetRef: `workflow_run:${runId}`, detail: { outcome, tool: tc?.tool ?? null } });
    return { jobId: job.id as string };
  });
  kick();
  return { id: runId, status: 'running', jobId: out.jobId };
}

registerJob(
  'workflow.advance',
  async (job) => {
    const p = job.job.payload;
    const e = { orgId: job.job.org_id, workspaceId: p.workspaceId, userId: p.userId };
    const r = await advanceWorkflowRun(e, p.runId, job);
    return { status: r?.status };
  },
  {
    // The job gave up (dead/failed): the run must not look like it is still running.
    async onGiveUp(job, error) {
      const p = job.payload;
      await withTenant({ orgId: job.org_id, userId: p.userId }, async (q) => {
        const n = await q.exec(`update workflow_runs set status='needs_attention', error=$2 where id=$1 and status in ('queued','running')`, [p.runId, `Automation stopped after retries: ${String(error).slice(0, 300)}`]);
        if (!n) return;
        const wf = await q.one('select w.name, w.owner_id from workflow_runs r join workflows w on w.id=r.workflow_id where r.id=$1', [p.runId]);
        if (wf) await notify(q, job.org_id, wf.owner_id, { category: 'workflow', title: `Workflow "${wf.name}" needs attention`, body: 'It stopped after several retries. Check it, then re-run it.', ref: { type: 'workflow_run', id: p.runId } });
      });
    },
  },
);

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
      await startWorkflowRun({ orgId: t.orgId, workspaceId: t.workspaceId, userId: wf.owner_id }, wf.id, { kind: `event:${ev.type}`, dedupeKey: ev.id, data: ev.data }, false, 'queue');
    }
  }
});

/**
 * Cron tick (Neon Function Trigger): marks due schedules and enqueues one job per workflow per day,
 * in the same transaction, so a crash cannot skip the day and a duplicate tick cannot run it twice.
 */
export async function runScheduledWorkflows(): Promise<{ started: number }> {
  const due = await withTenant({ orgId: null, userId: 'system:scheduler' }, (q) => q.many('select * from qline_due_schedules()'));
  let started = 0;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  for (const d of due) {
    const queued = await withTenant({ orgId: d.org_id, userId: d.owner_id }, async (q) => {
      const w = await q.one(
        `select w.workspace_id, v.definition->'trigger' as t from workflows w join workflow_versions v on v.workflow_id=w.id and v.version=w.published_version where w.id=$1`,
        [d.workflow_id],
      );
      await q.exec('update workflows set last_scheduled_at=now() where id=$1', [d.workflow_id]);
      if (w?.t?.every === 'week' && w.t.weekday != null && now.getUTCDay() !== Number(w.t.weekday)) return false; // not this weekday
      const j = await enqueue(q, {
        orgId: d.org_id,
        kind: 'workflow.scheduled',
        payload: { workflowId: d.workflow_id, workspaceId: w.workspace_id, ownerId: d.owner_id, day },
        idempotencyKey: `schedule:${d.workflow_id}:${day}`,
        createdBy: 'system:scheduler',
      });
      return j.created;
    });
    if (queued) started += 1;
  }
  return { started };
}

registerJob('workflow.scheduled', async ({ job }) => {
  const p = job.payload;
  const e = { orgId: job.org_id, workspaceId: p.workspaceId, userId: p.ownerId };
  const digest = await withTenant({ orgId: job.org_id, userId: p.ownerId }, (q) => buildDigest(q));
  const run = await startWorkflowRun(e, p.workflowId, { kind: 'schedule', dedupeKey: `schedule:${p.day}`, data: { date: p.day, ...digest } }, false, 'queue');
  return { runId: run?.id ?? null };
});

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
      if (s.type === 'slack' && !approved) throw badRequest('Posting to Slack needs an approval step before it.');
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

const RUN_VIEWS: Record<string, string[] | null> = {
  needs_you: ['waiting_approval', 'needs_attention'],
  active: ['queued', 'running'],
  failed: ['failed', 'rejected'],
  done: ['completed', 'cancelled'],
  all: null,
};

/** Execution history across workflows (M5). Read access follows workflows.read; RLS keeps it inside the org. */
workflowRoutes.get('/workflow-runs', async (c) => {
  const t = need(c, 'workflows.read');
  const p = query(
    c,
    z.object({ view: z.enum(['needs_you', 'active', 'failed', 'done', 'all']).default('all'), workflowId: z.string().uuid().optional(), before: z.string().datetime().optional(), limit: limitParam }),
  );
  const statuses = RUN_VIEWS[p.view];
  const data = await tx(t, async (q) => {
    const items = await q.many(
      `select r.id, r.workflow_id, w.name as workflow_name, r.status, r.trigger_kind, r.dry_run, r.started_at, r.ended_at, r.error, r.current_step,
              (select a.id from approval_requests a where a.status='pending' and a.preview->>'runId' = r.id::text order by a.created_at desc limit 1) as pending_approval_id,
              exists(select 1 from tool_calls tc where tc.workflow_run_id=r.id and tc.status in ('unknown','executing')) as outcome_unknown
         from workflow_runs r join workflows w on w.id = r.workflow_id
        where ($1::text[] is null or r.status = any($1)) and ($2::uuid is null or r.workflow_id = $2) and ($3::timestamptz is null or r.started_at < $3)
        order by r.started_at desc limit $4`,
      [statuses, p.workflowId ?? null, p.before ?? null, p.limit],
    );
    const counts = await q.one(
      `select count(*) filter (where status in ('waiting_approval','needs_attention'))::int as needs_you,
              count(*) filter (where status in ('queued','running'))::int as active,
              count(*) filter (where status in ('failed','rejected') and started_at > now() - interval '7 days')::int as failed_7d
         from workflow_runs where dry_run = false`,
    );
    return { items, counts };
  });
  return c.json(data);
});

workflowRoutes.get('/workflow-runs/:id', async (c) => {
  const t = need(c, 'workflows.read');
  const id = c.req.param('id');
  const extra = await tx(t, async (q) => {
    const run = await q.one('select r.id, r.status, r.current_step, w.id as workflow_id, w.name as workflow_name from workflow_runs r join workflows w on w.id=r.workflow_id where r.id=$1', [id]);
    if (!run) throw notFound('Workflow run');
    const approvals = await q.many(
      `select id, status, risk, preview->>'title' as title, (preview->>'gateStep') is not null as per_step, created_at, decided_at, expires_at from approval_requests where preview->>'runId'=$1 order by created_at`,
      [id],
    );
    const actions = await q.many(
      `select id, tool, status, policy_decision, result_summary, created_at, finished_at, split_part(idempotency_key, ':', 3)::int as step_index
         from tool_calls where workflow_run_id=$1 and tool <> 'workflow.approval' order by created_at`,
      [id],
    );
    const manage = can(t.role, 'workflows.manage');
    const jobs = manage ? await q.many(`select id, kind, status, attempts, max_attempts, last_error, created_at, finished_at from jobs where payload->>'runId'=$1 order by created_at`, [id]) : [];
    const unknown = actions.find((a: any) => (a.status === 'unknown' || a.status === 'executing') && a.step_index === run.current_step) ?? null;
    const attention =
      run.status !== 'needs_attention' ? null : unknown ? { kind: 'unknown_outcome', step: run.current_step, tool: unknown.tool, summary: unknown.result_summary } : { kind: 'stopped', step: run.current_step };
    const open = ['queued', 'running', 'waiting_approval', 'needs_attention'].includes(run.status);
    return { workflow: { id: run.workflow_id, name: run.workflow_name }, approvals, actions, jobs, attention, permissions: { canCancel: manage && open, canResolve: manage && t.human && !!attention } };
  });
  const detail = await getRunDetail({ orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId }, id);
  return c.json({ ...detail, ...extra });
});

workflowRoutes.post('/workflow-runs/:id/resolve', async (c) => {
  const t = need(c, 'workflows.manage');
  const input = await body(c, z.object({ outcome: z.enum(['happened', 'not_happened', 'retry']) }));
  return c.json(await resolveWorkflowRun(t, c.req.param('id'), input.outcome));
});

workflowRoutes.post('/workflow-runs/:id/cancel', async (c) => {
  const t = need(c, 'workflows.manage');
  return c.json(await cancelWorkflowRun(t, c.req.param('id')));
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
