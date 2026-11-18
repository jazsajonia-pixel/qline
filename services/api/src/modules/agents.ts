import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { canDecideApproval, can, routeAgent, TOOL_POLICIES, type AgentTemplate, type Risk } from '@qline/policy';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import { withTenant } from '../core/db';
import { isStopped } from '../core/controls';
import { ApiError, forbidden, notFound } from '../core/errors';
import { body, query } from '../core/validate';
import { executeRun, makeEmitter } from '../agent/runner';
import { getTool, IMPLEMENTED_TOOLS } from '../agent/tools';
import { applyWorkflowDecision, resumeWorkflowAfterDecision } from './workflows';
import { notify } from './work';

export const agentRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
agentRoutes.get('/agents', async (c) => {
  const t = c.get('tenant');
  const items = await tx(t, (q) =>
    q.many(
      `select a.id, a.template, a.name, a.status, a.current_version, v.instructions, v.model, v.provider, v.tool_allowlist,
              (select count(*)::int from agent_runs r where r.agent_id=a.id and r.created_at > now() - interval '7 days') as runs_week,
              (select max(r.created_at) from agent_runs r where r.agent_id=a.id) as last_run_at
       from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version
       where a.status <> 'archived' order by case a.template when 'ceo' then 0 else 1 end, a.name`,
    ),
  );
  return c.json({
    items: items.map((a: any) => ({
      ...a,
      tools: a.tool_allowlist.map((name: string) => ({
        name,
        risk: TOOL_POLICIES[name]?.risk,
        decision: TOOL_POLICIES[name]?.decision,
        implemented: (IMPLEMENTED_TOOLS as string[]).includes(name),
      })),
    })),
  });
});

agentRoutes.get('/agents/:id', async (c) => {
  const t = c.get('tenant');
  const data = await tx(t, async (q) => {
    const a = await q.one(
      `select a.*, v.instructions, v.model, v.provider, v.tool_allowlist from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version where a.id=$1`,
      [c.req.param('id')],
    );
    if (!a) throw notFound('Agent');
    const versions = await q.many('select version, created_by, created_at from agent_versions where agent_id=$1 order by version desc', [a.id]);
    const runs = await q.many('select id, status, trigger, input_tokens, output_tokens, created_at, ended_at, error from agent_runs where agent_id=$1 order by created_at desc limit 20', [a.id]);
    return { ...a, versions, runs };
  });
  return c.json(data);
});

/** Humans only: agents never reach this route (invariant 4, docs/07 §4). */
agentRoutes.patch('/agents/:id', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(
    c,
    z.object({
      status: z.enum(['active', 'paused']).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      instructions: z.string().trim().min(1).max(8000).optional(),
      toolAllowlist: z.array(z.string()).max(40).optional(),
    }),
  );
  const row = await tx(t, async (q) => {
    const a = await q.one(`select a.*, v.instructions, v.model, v.provider, v.tool_allowlist from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version where a.id=$1`, [c.req.param('id')]);
    if (!a) throw notFound('Agent');
    if (input.toolAllowlist) {
      // Only tools that the template is entitled to (policy floor); never widen beyond it.
      for (const tool of input.toolAllowlist) {
        const p = TOOL_POLICIES[tool];
        if (!p || !p.templates.includes(a.template)) throw forbidden(`${tool} is not available to the ${a.template} agent.`);
      }
    }
    if (input.instructions || input.toolAllowlist) {
      const next = a.current_version + 1;
      await q.exec(
        `insert into agent_versions (org_id, agent_id, version, instructions, model, provider, tool_allowlist, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [t.orgId, a.id, next, input.instructions ?? a.instructions, a.model, a.provider, input.toolAllowlist ?? a.tool_allowlist, `user:${t.userId}`],
      );
      await q.exec('update agents set current_version=$2 where id=$1', [a.id, next]);
    }
    if (input.status || input.name) await q.exec('update agents set status=coalesce($2,status), name=coalesce($3,name) where id=$1', [a.id, input.status ?? null, input.name ?? null]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.updated', targetRef: `agent:${a.id}`, detail: { ...input, instructions: input.instructions ? '[changed]' : undefined } });
    return q.one('select * from agents where id=$1', [a.id]);
  });
  return c.json(row);
});

// ---------------------------------------------------------------------------
// Conversations & runs
// ---------------------------------------------------------------------------
agentRoutes.get('/conversations', async (c) => {
  const t = need(c, 'agents.use');
  const p = query(c, z.object({ q: z.string().max(200).optional() }));
  const items = await tx(t, (q) =>
    q.many(
      `select c.id, c.title, c.agent_id, a.name as agent_name, a.template, c.updated_at,
         (select content from conversation_messages m where m.conversation_id=c.id order by created_at desc limit 1) as last_message
       from conversations c join agents a on a.id=c.agent_id where c.user_id=$1 and ($2::text is null or c.title ilike '%'||$2||'%')
       order by c.updated_at desc limit 50`,
      [t.userId, p.q ?? null],
    ),
  );
  return c.json({ items });
});

agentRoutes.post('/conversations', async (c) => {
  const t = need(c, 'agents.use');
  const input = await body(c, z.object({ agentId: z.string().uuid().optional(), title: z.string().max(120).optional() }));
  const row = await tx(t, async (q) => {
    const agent = input.agentId
      ? await q.one('select id from agents where id=$1', [input.agentId])
      : await q.one(`select id from agents where workspace_id=$1 and template='ceo'`, [t.workspaceId]);
    if (!agent) throw notFound('Agent');
    return q.one(`insert into conversations (org_id, workspace_id, agent_id, user_id, title) values ($1,$2,$3,$4,$5) returning *`, [
      t.orgId,
      t.workspaceId,
      agent.id,
      t.userId,
      input.title ?? 'New conversation',
    ]);
  });
  return c.json(row, 201);
});

agentRoutes.get('/conversations/:id', async (c) => {
  const t = need(c, 'agents.use');
  const data = await tx(t, async (q) => {
    const conv = await q.one(`select c.*, a.name as agent_name, a.template from conversations c join agents a on a.id=c.agent_id where c.id=$1 and c.user_id=$2`, [c.req.param('id'), t.userId]);
    if (!conv) throw notFound('Conversation');
    const messages = await q.many('select id, role, content, run_id, refs, meta, created_at from conversation_messages where conversation_id=$1 order by created_at', [conv.id]);
    return { ...conv, messages };
  });
  return c.json(data);
});

agentRoutes.post('/conversations/:id/messages', async (c) => {
  const t = need(c, 'agents.use');
  const { content, agent: pick } = await body(c, z.object({ content: z.string().trim().min(1).max(8000), agent: z.union([z.literal('auto'), z.string().uuid()]).optional() }));
  const out = await tx(t, async (q) => {
    const conv = await q.one(`select c.*, a.current_version, a.status as agent_status from conversations c join agents a on a.id=c.agent_id where c.id=$1 and c.user_id=$2`, [c.req.param('id'), t.userId]);
    if (!conv) throw notFound('Conversation');
    const busy = await q.one(`select id from agent_runs where conversation_id=$1 and status in ('queued','running')`, [conv.id]);
    if (busy) throw new ApiError(409, 'RUN_IN_PROGRESS', 'Already answering', 'Wait for the current answer or cancel it.');
    // v1.6: answer with another agent for this message — picked by the user, or routed automatically ('auto').
    let agent = { id: conv.agent_id as string, version: conv.current_version as number };
    let routed: { id: string; name: string; template: string } | null = null;
    if (pick) {
      const active = await q.many<{ id: string; name: string; template: AgentTemplate; current_version: number }>(`select id, name, template, current_version from agents where workspace_id=$1 and status='active'`, [conv.workspace_id]);
      const chosen = pick === 'auto' ? active.find((a) => a.template === routeAgent(content, active.map((x) => x.template))) : active.find((a) => a.id === pick);
      if (pick !== 'auto' && !chosen) throw notFound('Agent');
      if (chosen) {
        agent = { id: chosen.id, version: chosen.current_version };
        routed = { id: chosen.id, name: chosen.name, template: chosen.template };
      }
    }
    const v = await q.one('select id from agent_versions where agent_id=$1 and version=$2', [agent.id, agent.version]);
    const run = await q.one<{ id: string }>(
      `insert into agent_runs (org_id, conversation_id, agent_id, agent_version_id, initiated_by, trigger) values ($1,$2,$3,$4,$5,'chat') returning id`,
      [t.orgId, conv.id, agent.id, v.id, t.userId],
    );
    const msg = await q.one(`insert into conversation_messages (org_id, conversation_id, role, content, run_id) values ($1,$2,'user',$3,$4) returning id, created_at`, [
      t.orgId,
      conv.id,
      content,
      run!.id,
    ]);
    if (conv.title === 'New conversation') await q.exec('update conversations set title=$2, updated_at=now() where id=$1', [conv.id, content.slice(0, 60)]);
    return { runId: run!.id, messageId: msg.id, agent: routed };
  });
  return c.json(out, 202);
});

agentRoutes.get('/runs/:id', async (c) => {
  const t = need(c, 'agents.use');
  const data = await tx(t, async (q) => {
    const run = await q.one('select * from agent_runs where id=$1 and initiated_by=$2', [c.req.param('id'), t.userId]);
    if (!run) throw notFound('Run');
    const toolCalls = await q.many('select id, tool, risk, policy_decision, status, result_summary, result_refs, created_at from tool_calls where run_id=$1 order by created_at', [run.id]);
    const events = await q.many('select seq, event, data from run_events where run_id=$1 order by seq', [run.id]);
    return { ...run, toolCalls, events };
  });
  return c.json(data);
});

agentRoutes.post('/runs/:id/cancel', async (c) => {
  const t = need(c, 'agents.use');
  const n = await tx(t, (q) => q.exec(`update agent_runs set status='cancelled', ended_at=now() where id=$1 and initiated_by=$2 and status in ('queued','running')`, [c.req.param('id'), t.userId]));
  if (!n) throw notFound('Active run');
  return c.json({ ok: true });
});

/**
 * Run stream. The first subscriber claims a queued run and executes it in this
 * request (Neon Functions are long-running, docs: runtime limits). Any other
 * subscriber, or a reconnect with Last-Event-ID, replays persisted events.
 */
agentRoutes.get('/runs/:id/stream', async (c) => {
  const t = need(c, 'agents.use');
  const runId = c.req.param('id');
  const lastId = Number(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? '0') || 0;
  const run = await tx(t, (q) => q.one('select id, status from agent_runs where id=$1 and initiated_by=$2', [runId, t.userId]));
  if (!run) throw notFound('Run');

  return streamSSE(c, async (stream) => {
    const claimed = await tx(t, (q) => q.one(`update agent_runs set status='running', started_at=now() where id=$1 and status='queued' returning id`, [runId]));
    if (claimed) {
      const ac = new AbortController();
      stream.onAbort(() => {
        /* keep running so the answer is saved even if the client drops */
      });
      const emit = makeEmitter({ ...t }, runId, async (seq, event, data) => {
        await stream.writeSSE({ id: String(seq), event, data: JSON.stringify(data) });
      });
      await executeRun({ orgId: t.orgId, workspaceId: t.workspaceId, userId: t.userId, role: t.role }, runId, emit, ac.signal);
      return;
    }
    // Replay + follow.
    let cursor = lastId;
    const deadline = Date.now() + 150_000;
    for (;;) {
      const { events, status } = await tx(t, async (q) => ({
        events: await q.many('select seq, event, data from run_events where run_id=$1 and seq > $2 order by seq', [runId, cursor]),
        status: (await q.one('select status from agent_runs where id=$1', [runId]))?.status,
      }));
      for (const e of events) {
        cursor = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: e.event, data: JSON.stringify(e.data) });
      }
      if (status !== 'running' && status !== 'queued') break;
      if (Date.now() > deadline) break;
      await stream.sleep(800);
    }
  });
});

// ---------------------------------------------------------------------------
// Approvals — decisions only from human sessions (invariant 1)
// ---------------------------------------------------------------------------
agentRoutes.get('/approvals', async (c) => {
  const t = c.get('tenant');
  const p = query(c, z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed', 'failed', 'all']).default('pending') }));
  await tx(t, (q) => q.exec(`update approval_requests set status='expired' where status='pending' and expires_at < now()`));
  const items = await tx(t, (q) =>
    q.many(
      `select ar.*, coalesce(a.name, w.name) as requester_name from approval_requests ar
       left join agents a on ar.requester_kind='agent' and a.id=ar.requester_id
       left join workflows w on ar.requester_kind='workflow' and w.id=ar.requester_id
       where ($1 = 'all' or ar.status=$1) order by ar.created_at desc limit 100`,
      [p.status],
    ),
  );
  return c.json({ items: items.map((a: any) => ({ ...a, canDecide: canDecideApproval(t.role, a.risk as Risk) })) });
});

agentRoutes.get('/approvals/:id', async (c) => {
  const t = c.get('tenant');
  const a = await tx(t, (q) => q.one('select * from approval_requests where id=$1', [c.req.param('id')]));
  if (!a) throw notFound('Approval');
  return c.json({ ...a, canDecide: canDecideApproval(t.role, a.risk) });
});

agentRoutes.post('/approvals/:id/decision', async (c) => {
  const t = c.get('tenant');
  if (c.req.header('x-qline-service')) throw forbidden('Approval decisions must come from a person.');
  const input = await body(c, z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() }));
  const result = await decideApproval(t, c.req.param('id'), input.decision, input.note);
  return c.json(result);
});

export async function decideApproval(t: TenantCtx, approvalId: string, decision: 'approve' | 'reject', note?: string) {
  if (!t.human) throw forbidden('Approval decisions must come from a person.');
  // v1.5 emergency stop: nothing approved runs while it is on (the request stays pending; rejecting is fine).
  if (decision === 'approve' && (await tx(t, (q) => isStopped(q, t.workspaceId)))) {
    throw new ApiError(409, 'EMERGENCY_STOP', 'Emergency stop is on', 'Turn off the emergency stop before approving actions.');
  }
  // Lock the row so a double tap cannot execute twice.
  const claimed = await tx(t, async (q) => {
    const a = await q.one('select * from approval_requests where id=$1 for update', [approvalId]);
    if (!a) throw notFound('Approval');
    if (a.status !== 'pending') throw new ApiError(409, 'APPROVAL_ALREADY_DECIDED', 'Already decided', `This request is ${a.status}.`);
    if (new Date(a.expires_at) < new Date()) {
      await q.exec(`update approval_requests set status='expired' where id=$1`, [a.id]);
      throw new ApiError(409, 'APPROVAL_EXPIRED', 'Expired', 'This request expired. Ask again.');
    }
    if (!canDecideApproval(t.role, a.risk)) throw forbidden(`Your role cannot decide ${a.risk} requests.`);
    const tc = await q.one('select * from tool_calls where id=$1', [a.tool_call_id]);
    await q.exec(`update approval_requests set status=$2, decided_by_user=$3, decided_at=now(), decision_note=$4 where id=$1`, [
      a.id,
      decision === 'approve' ? 'approved' : 'rejected',
      t.userId,
      note ?? null,
    ]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: `approval.${decision === 'approve' ? 'approved' : 'rejected'}`, targetRef: `approval:${a.id}`, detail: { action: a.action, risk: a.risk } });
    // Workflow approvals: the run update and its resume job commit with the decision (no lost resumes).
    const applied = a.requester_kind === 'workflow' ? await applyWorkflowDecision(q, t, a, decision) : null;
    return { a, tc, applied };
  });
  const { a, tc, applied } = claimed;

  if (a.requester_kind === 'workflow') {
    const r = await resumeWorkflowAfterDecision(t, applied!);
    return { status: r.status, approval: { id: a.id, status: decision === 'approve' ? 'approved' : 'rejected' }, workflowRun: r };
  }

  // Agent tool call
  const run = tc.run_id ? await tx(t, (q) => q.one('select * from agent_runs where id=$1', [tc.run_id])) : null;
  if (decision === 'reject') {
    await tx(t, async (q) => {
      await q.exec(`update tool_calls set status='rejected', finished_at=now() where id=$1`, [tc.id]);
      if (run) {
        await q.exec(`insert into conversation_messages (org_id, conversation_id, role, content, run_id) values ($1,$2,'system_notice',$3,$4)`, [
          t.orgId,
          run.conversation_id,
          `Rejected: ${a.preview?.title ?? a.action}. Nothing was changed.`,
          run.id,
        ]);
        await q.exec(`update agent_runs set status='completed', ended_at=now() where id=$1 and status='waiting_approval' and not exists (select 1 from tool_calls where run_id=$1 and status='waiting_approval')`, [run.id]);
      }
    });
    return { status: 'rejected', approval: { id: a.id, status: 'rejected' } };
  }

  // Approve → re-check that the human the agent acted for may still do this, then execute once.
  const tool = getTool(tc.tool);
  const requestedFor = await tx(t, (q) => q.one('select role from organization_members where org_id=$1 and user_id=$2 and status=$3', [t.orgId, a.requested_for, 'active']));
  const policy = TOOL_POLICIES[tc.tool];
  const allowed = !!tool && !!policy && !!requestedFor && can(requestedFor.role, policy.requires) && can(t.role, policy.requires);
  if (!allowed) {
    await tx(t, async (q) => {
      await q.exec(`update tool_calls set status='failed', result_summary='Permission re-check failed', finished_at=now() where id=$1`, [tc.id]);
      await q.exec(`update approval_requests set status='failed' where id=$1`, [a.id]);
    });
    throw forbidden('Permission re-check failed, so the action was not run.');
  }
  try {
    const out = await tx(t, async (q) => {
      const r = await tool!.execute(q, { orgId: t.orgId, workspaceId: t.workspaceId, userId: a.requested_for, actor: { kind: 'agent', id: a.requester_id } }, tc.args);
      await q.exec(`update tool_calls set status=$2, result_summary=$3, result_refs=$4, finished_at=now() where id=$1`, [tc.id, r.ok ? 'succeeded' : 'failed', r.summary, JSON.stringify(r.refs)]);
      await q.exec(`update approval_requests set status=$2 where id=$1`, [a.id, r.ok ? 'executed' : 'failed']);
      if (run) {
        await q.exec(`insert into conversation_messages (org_id, conversation_id, role, content, run_id, refs) values ($1,$2,'system_notice',$3,$4,$5)`, [
          t.orgId,
          run.conversation_id,
          r.ok ? `Approved and done: ${r.summary}.` : `Approved, but it failed: ${r.summary}.`,
          run.id,
          JSON.stringify(r.refs),
        ]);
        await q.exec(`update agent_runs set status='completed', ended_at=now() where id=$1 and status='waiting_approval' and not exists (select 1 from tool_calls where run_id=$1 and status='waiting_approval')`, [run.id]);
      }
      if (a.requested_for !== t.userId) await notify(q, t.orgId, a.requested_for, { category: 'approval', title: `Approved: ${a.preview?.title ?? a.action}` });
      return r;
    });
    return { status: out.ok ? 'executed' : 'failed', result: out, approval: { id: a.id, status: out.ok ? 'executed' : 'failed' } };
  } catch (e) {
    await withTenant({ orgId: t.orgId, userId: t.userId }, async (q) => {
      await q.exec(`update tool_calls set status='failed', result_summary=$2, finished_at=now() where id=$1`, [tc.id, (e as Error).message.slice(0, 300)]);
      await q.exec(`update approval_requests set status='failed' where id=$1`, [a.id]);
    });
    throw new ApiError(500, 'ACTION_FAILED', 'The approved action failed', (e as Error).message);
  }
}
