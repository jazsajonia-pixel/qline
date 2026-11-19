import { safeError, trackExternal, UNKNOWN_SUMMARY } from '../core/external';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { canDecideApproval, can, routeAgent, TOOL_POLICIES, toolLabels, type AgentTemplate, type Risk } from '@qline/policy';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import { withTenant } from '../core/db';
import { isStopped } from '../core/controls';
import { ApiError, forbidden, notFound } from '../core/errors';
import { body, query } from '../core/validate';
import { complete, ProviderError } from '@qline/ai';
import { executeRun, makeEmitter, MAX_TOOL_CALLS } from '../agent/runner';
import { reportKey } from '../agent/keys';
import { stripMeta } from '../agent/meta';
import { resolveModel } from '../agent/models';
import { checkAllowlist, entitlement, loadAgent, newVersion, readOnlyTools, type VersionFields } from '../agent/versions';
import { ledgerStats } from '../agent/context-ledger';
import { getTool, IMPLEMENTED_TOOLS } from '../agent/tools';
import { applyWorkflowDecision, resumeWorkflowAfterDecision } from './workflows';
import { notify } from './work';
import { loadAttachments } from './files';

export const agentRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
agentRoutes.get('/agents', async (c) => {
  const t = c.get('tenant');
  const items = await tx(t, (q) =>
    q.many(
      `select a.id, a.template, a.name, a.status, a.current_version, a.description, a.icon, a.accent, a.based_on,
              v.instructions, v.model, v.provider, v.tool_allowlist, v.key_id, v.approval_mode, v.max_tool_calls, v.daily_runs, v.max_concurrent,
              (select count(*)::int from agent_runs r where r.agent_id=a.id and r.created_at > now() - interval '7 days') as runs_week,
              (select max(r.created_at) from agent_runs r where r.agent_id=a.id) as last_run_at
       from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version
       where a.status <> 'archived' order by case a.template when 'ceo' then 0 when 'custom' then 2 else 1 end, a.name`,
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
    const a = await loadAgent(q, c.req.param('id'));
    if (!a) throw notFound('Agent');
    const versions = await q.many(
      `select v.version, v.created_by, v.created_at, left(v.instructions, 200) as instructions_preview, v.model, v.provider, v.approval_mode, v.max_tool_calls, k.alias as key_alias
         from agent_versions v left join ai_keys k on k.id=v.key_id where v.agent_id=$1 order by v.version desc limit 50`,
      [a.id],
    );
    const key = a.key_id ? await q.one('select id, alias, provider, enabled, status from ai_keys where id=$1', [a.key_id]) : null;
    const runs = await q.many('select id, status, trigger, input_tokens, output_tokens, created_at, ended_at, error from agent_runs where agent_id=$1 order by created_at desc limit 20', [a.id]);
    return { ...a, entitlement: entitlement(a), key, versions, runs };
  });
  return c.json(data);
});

const ICON = z.string().regex(/^[a-z_]{1,40}$/);
const ACCENT = z.enum(['violet', 'mint', 'citrine', 'coral', 'sky', 'rose']);
const PROFILE = z.enum(['ceo', 'sales', 'marketing', 'finance', 'operations', 'research']);
const BUDGETS = {
  approvalMode: z.enum(['policy', 'ask_all']).optional(),
  maxToolCalls: z.number().int().min(0).max(MAX_TOOL_CALLS).optional(),
  dailyRuns: z.number().int().min(1).max(1000).nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(5).nullable().optional(),
};
export const MAX_CUSTOM_AGENTS = 20;

function versionChanges(input: { instructions?: string; toolAllowlist?: string[]; approvalMode?: 'policy' | 'ask_all'; maxToolCalls?: number; dailyRuns?: number | null; maxConcurrent?: number | null }) {
  const ch: Partial<VersionFields> = {};
  if (input.instructions !== undefined) ch.instructions = input.instructions;
  if (input.toolAllowlist !== undefined) ch.tool_allowlist = [...new Set(input.toolAllowlist)];
  if (input.approvalMode !== undefined) ch.approval_mode = input.approvalMode;
  if (input.maxToolCalls !== undefined) ch.max_tool_calls = input.maxToolCalls;
  if (input.dailyRuns !== undefined) ch.daily_runs = input.dailyRuns;
  if (input.maxConcurrent !== undefined) ch.max_concurrent = input.maxConcurrent;
  return ch;
}

/** Humans only: agents never reach this route (invariant 4, docs/07 §4). */
agentRoutes.patch('/agents/:id', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(
    c,
    z.object({
      status: z.enum(['active', 'paused']).optional(),
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(300).nullable().optional(),
      icon: ICON.nullable().optional(),
      accent: ACCENT.nullable().optional(),
      instructions: z.string().trim().min(1).max(8000).optional(),
      toolAllowlist: z.array(z.string()).max(40).optional(),
      ...BUDGETS,
    }),
  );
  const row = await tx(t, async (q) => {
    const a = await loadAgent(q, c.req.param('id'));
    if (!a || a.status === 'archived') throw notFound('Agent');
    if (input.toolAllowlist) checkAllowlist(a, input.toolAllowlist);
    const ch = versionChanges(input);
    if (Object.keys(ch).length) await newVersion(q, t.orgId, a, ch, `user:${t.userId}`);
    if (input.status || input.name) await q.exec('update agents set status=coalesce($2,status), name=coalesce($3,name) where id=$1', [a.id, input.status ?? null, input.name ?? null]);
    if (input.description !== undefined || input.icon !== undefined || input.accent !== undefined) {
      await q.exec(
        `update agents set description = case when $2 then $3 else description end, icon = case when $4 then $5 else icon end, accent = case when $6 then $7 else accent end where id=$1`,
        [a.id, input.description !== undefined, input.description ?? null, input.icon !== undefined, input.icon ?? null, input.accent !== undefined, input.accent ?? null],
      );
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.updated', targetRef: `agent:${a.id}`, detail: { ...input, instructions: input.instructions ? '[changed]' : undefined } });
    return q.one('select * from agents where id=$1', [a.id]);
  });
  return c.json(row);
});

/**
 * Phase 4 / M9: a person creates their own agent, from scratch or as a copy. It starts paused, with least privilege:
 * its tools can only come from the built-in profile it is based on, and a new one from scratch gets read-only tools.
 */
agentRoutes.post('/agents', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(300).optional(),
      icon: ICON.optional(),
      accent: ACCENT.optional(),
      basedOn: PROFILE.optional(),
      cloneFrom: z.string().uuid().optional(),
      instructions: z.string().trim().min(1).max(8000).optional(),
      toolAllowlist: z.array(z.string()).max(40).optional(),
      ...BUDGETS,
    }),
  );
  const row = await tx(t, async (q) => {
    const count = await q.one<{ n: number }>(`select count(*)::int as n from agents where workspace_id=$1 and template='custom' and status <> 'archived'`, [t.workspaceId]);
    if (count!.n >= MAX_CUSTOM_AGENTS) throw new ApiError(409, 'AGENT_LIMIT', `You can have up to ${MAX_CUSTOM_AGENTS} of your own agents`, 'Archive one you no longer use first.');
    const src = input.cloneFrom ? await loadAgent(q, input.cloneFrom) : null;
    if (input.cloneFrom && (!src || src.status === 'archived')) throw notFound('Agent');
    const profile = (input.basedOn ?? (src ? entitlement(src) : 'research')) as AgentTemplate;
    const draft = { template: 'custom', based_on: profile };
    const tools = input.toolAllowlist ?? (src && entitlement(src) === profile ? src.tool_allowlist : readOnlyTools(profile));
    checkAllowlist(draft, tools);
    const instructions = input.instructions ?? src?.instructions;
    if (!instructions) throw new ApiError(400, 'VALIDATION', 'Write instructions for this agent', 'Say what it should help with and how.');
    const a = await q.one<{ id: string }>(
      `insert into agents (org_id, workspace_id, template, name, status, created_by, description, icon, accent, based_on)
       values ($1,$2,'custom',$3,'paused',$4,$5,$6,$7,$8) returning id`,
      [t.orgId, t.workspaceId, input.name, t.userId, input.description ?? src?.description ?? null, input.icon ?? src?.icon ?? null, input.accent ?? src?.accent ?? null, profile],
    );
    await q.exec(
      `insert into agent_versions (org_id, agent_id, version, instructions, model, provider, tool_allowlist, key_id, approval_mode, max_tool_calls, daily_runs, max_concurrent, created_by)
       values ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        t.orgId,
        a!.id,
        instructions,
        src?.model ?? 'default',
        src?.provider ?? null,
        [...new Set(tools)],
        src?.key_id ?? null,
        input.approvalMode ?? src?.approval_mode ?? 'policy',
        input.maxToolCalls ?? src?.max_tool_calls ?? MAX_TOOL_CALLS,
        input.dailyRuns ?? src?.daily_runs ?? null,
        input.maxConcurrent ?? src?.max_concurrent ?? null,
        `user:${t.userId}`,
      ],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.created', targetRef: `agent:${a!.id}`, detail: { name: input.name, basedOn: profile, cloneFrom: input.cloneFrom ?? null, tools: tools.length } });
    return q.one('select * from agents where id=$1', [a!.id]);
  });
  return c.json(row, 201);
});

/** Restores an earlier version's settings as a new version (history is never rewritten). */
agentRoutes.post('/agents/:id/revert', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(c, z.object({ version: z.number().int().min(1) }));
  const out = await tx(t, async (q) => {
    const a = await loadAgent(q, c.req.param('id'));
    if (!a || a.status === 'archived') throw notFound('Agent');
    const old = await q.one<any>('select * from agent_versions where agent_id=$1 and version=$2', [a.id, input.version]);
    if (!old) throw notFound('Version');
    checkAllowlist(a, old.tool_allowlist);
    const keyOk = old.key_id ? await q.one('select 1 from ai_keys where id=$1', [old.key_id]) : null;
    const next = await newVersion(
      q,
      t.orgId,
      a,
      {
        instructions: old.instructions,
        model: old.model,
        provider: old.provider,
        tool_allowlist: old.tool_allowlist,
        key_id: keyOk ? old.key_id : null,
        approval_mode: old.approval_mode,
        max_tool_calls: old.max_tool_calls,
        daily_runs: old.daily_runs,
        max_concurrent: old.max_concurrent,
      },
      `user:${t.userId}`,
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.reverted', targetRef: `agent:${a.id}`, detail: { to: input.version, version: next } });
    return { id: a.id, version: next, restored: input.version, keyDropped: !!old.key_id && !keyOk };
  });
  return c.json(out);
});

/** Archives one of the person's own agents. Built-in agents can only be paused. Chats with it stay readable. */
agentRoutes.delete('/agents/:id', async (c) => {
  const t = need(c, 'agents.manage');
  await tx(t, async (q) => {
    const a = await q.one('select id, template, status from agents where id=$1', [c.req.param('id')]);
    if (!a || a.status === 'archived') throw notFound('Agent');
    if (a.template !== 'custom') throw new ApiError(409, 'AGENT_BUILT_IN', 'Built-in agents cannot be removed', 'Pause it instead.');
    await q.exec(`update agents set status='archived' where id=$1`, [a.id]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.archived', targetRef: `agent:${a.id}` });
  });
  return c.json({ ok: true });
});

/**
 * Tries an agent's instructions on one message without tools and without saving anything, so a person can see how
 * it answers before activating it. Works for paused agents. Optional `instructions` previews an unsaved edit.
 */
agentRoutes.post('/agents/:id/preview', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(c, z.object({ message: z.string().trim().min(1).max(2000), instructions: z.string().trim().min(1).max(8000).optional() }));
  const setup = await tx(t, async (q) => {
    const a = await loadAgent(q, c.req.param('id'));
    if (!a || a.status === 'archived') throw notFound('Agent');
    const resolved = await resolveModel(q, t.orgId, { provider: a.provider, model: a.model, name: a.name, keyId: a.key_id });
    return { a, resolved };
  });
  const { a, resolved } = setup;
  if (!resolved.ok) throw new ApiError(409, resolved.code, resolved.message);
  const started = Date.now();
  try {
    const r = await complete(
      resolved.provider,
      {
        model: resolved.model,
        maxTokens: 800,
        messages: [
          { role: 'system', content: `You are "${a.name}", an AI agent inside Qline. This is a preview: you have no tools, so do not claim to look anything up or change anything. ${input.instructions ?? a.instructions}` },
          { role: 'user', content: input.message },
        ],
      },
      AbortSignal.timeout(45_000),
    );
    if (resolved.keyId) await tx(t, (q) => reportKey(q, resolved.keyId!, 'ok')).catch(() => {});
    return c.json({ ok: true, reply: stripMeta(r.text).trim().slice(0, 4000), model: resolved.model, provider: resolved.providerId, key: resolved.keyAlias, latencyMs: Date.now() - started });
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError('PROVIDER_UNAVAILABLE', (e as Error).message, true);
    if (resolved.keyId) {
      const outcome = pe.code === 'PROVIDER_RATE_LIMITED' ? 'rate_limited' : pe.code === 'PROVIDER_AUTH_FAILED' ? 'auth_failed' : 'error';
      await tx(t, (q) => reportKey(q, resolved.keyId!, outcome, pe.message)).catch(() => {});
    }
    return c.json({ ok: false, code: pe.code, message: pe.message.slice(0, 400), key: resolved.keyAlias, latencyMs: Date.now() - started });
  }
});

// ---------------------------------------------------------------------------
// Conversations & runs
// ---------------------------------------------------------------------------
/** A chat answer runs inside its stream request and is capped at 2 minutes, so a run still "active" after this died. */
export const STALE_RUN_MIN = 5;

/**
 * M2: marks runs of this conversation that can no longer be running (server restarted or the request was cut off
 * mid-answer) as interrupted, so they stop blocking the conversation with "Already answering".
 */
async function expireStaleRuns(q: Parameters<Parameters<typeof tx>[1]>[0], conversationId: string) {
  const dead = await q.many<{ id: string }>(
    `update agent_runs set status='failed', error='Interrupted', ended_at=now()
      where conversation_id=$1 and status in ('queued','running') and coalesce(started_at, created_at) < now() - make_interval(mins => $2)
      returning id`,
    [conversationId, STALE_RUN_MIN],
  );
  for (const r of dead)
    await q.exec(`insert into conversation_messages (org_id, conversation_id, role, content, run_id) select org_id, id, 'system_notice', $2, $3 from conversations where id=$1`, [
      conversationId,
      'That answer was interrupted. Send your message again.',
      r.id,
    ]);
}

agentRoutes.get('/conversations', async (c) => {
  const t = need(c, 'agents.use');
  const p = query(c, z.object({ q: z.string().max(200).optional() }));
  const items = await tx(t, (q) =>
    q.many(
      `select c.id, c.title, c.agent_id, a.name as agent_name, a.template, c.updated_at,
         (select content from conversation_messages m where m.conversation_id=c.id order by created_at desc limit 1) as last_message
       from conversations c join agents a on a.id=c.agent_id
       where c.user_id=$1 and c.workspace_id=$3 and ($2::text is null or c.title ilike '%'||$2||'%')
       order by c.updated_at desc limit 50`,
      [t.userId, p.q ?? null, t.workspaceId],
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
    const conv = await q.one(
      `select c.*, a.name as agent_name, a.template from conversations c join agents a on a.id=c.agent_id where c.id=$1 and c.user_id=$2 and c.workspace_id=$3`,
      [c.req.param('id'), t.userId, t.workspaceId],
    );
    if (!conv) throw notFound('Conversation');
    await expireStaleRuns(q, conv.id);
    const messages = await q.many(`select m.id, m.role, m.content, m.run_id, m.refs, m.meta, m.created_at,
              case when m.role = 'assistant' and m.run_id is not null then (select count(*)::int from tool_calls tc where tc.run_id = m.run_id) else 0 end as steps
         from conversation_messages m where m.conversation_id=$1 order by m.created_at`, [conv.id]);
    // M2: an answer still being written when the app reopens, so the client can follow it instead of losing it.
    const active_run = await q.one(`select id, status, created_at from agent_runs where conversation_id=$1 and initiated_by=$2 and status in ('queued','running') order by created_at desc limit 1`, [
      conv.id,
      t.userId,
    ]);
    return { ...conv, messages, active_run: active_run ?? null };
  });
  return c.json(data);
});

agentRoutes.post('/conversations/:id/messages', async (c) => {
  const t = need(c, 'agents.use');
  const input = await body(
    c,
    z
      .object({
        content: z.string().trim().max(8000).default(''),
        agent: z.union([z.literal('auto'), z.string().uuid()]).optional(),
        // v1.6: files sent with this message (ids from POST /agents/attachments)
        attachments: z.array(z.string().uuid()).max(5).default([]),
        // M2: skip reusing earlier lookups for this reply (the user wants current data)
        fresh: z.boolean().optional(),
        // Run 3 / M4: knowledge entries the person added to this message from the in-chat map
        knowledge: z.array(z.string().uuid()).max(5).default([]),
      })
      .refine((v) => v.content.length > 0 || v.attachments.length > 0, { message: 'Write a message or attach a file.', path: ['content'] }),
  );
  const { agent: pick, attachments: attachmentIds } = input;
  const content = input.content || 'Please look at the attached file.';
  const out = await tx(t, async (q) => {
    const conv = await q.one(
      `select c.*, a.current_version, a.status as agent_status from conversations c join agents a on a.id=c.agent_id where c.id=$1 and c.user_id=$2 and c.workspace_id=$3`,
      [c.req.param('id'), t.userId, t.workspaceId],
    );
    if (!conv) throw notFound('Conversation');
    await expireStaleRuns(q, conv.id);
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
    const v = await q.one('select id, daily_runs, max_concurrent from agent_versions where agent_id=$1 and version=$2', [agent.id, agent.version]);
    // Phase 4 / M9: the agent's own run budgets, checked under a per-agent lock so parallel sends cannot overshoot.
    if (v.daily_runs || v.max_concurrent) {
      await q.exec(`select pg_advisory_xact_lock(hashtextextended('qline.agent_budget:' || $1::text, 0))`, [agent.id]);
      const use = await q.one<{ today: number; live: number }>(
        `select count(*) filter (where created_at >= date_trunc('day', now()))::int as today,
                count(*) filter (where status in ('queued','running') and coalesce(started_at, created_at) > now() - make_interval(mins => $2))::int as live
           from agent_runs where agent_id=$1 and created_at >= least(date_trunc('day', now()), now() - make_interval(mins => $2))`,
        [agent.id, STALE_RUN_MIN],
      );
      if (v.daily_runs && use!.today >= v.daily_runs)
        throw new ApiError(429, 'AGENT_BUDGET_REACHED', `This agent reached its limit of ${v.daily_runs} answers today`, 'The limit resets at 00:00 UTC. You can raise it in the agent settings.');
      if (v.max_concurrent && use!.live >= v.max_concurrent)
        throw new ApiError(429, 'AGENT_BUSY', `This agent is already answering ${use!.live} other chat${use!.live === 1 ? '' : 's'}`, 'Wait for one to finish, or raise its limit in the agent settings.');
    }
    const run = await q.one<{ id: string }>(
      `insert into agent_runs (org_id, conversation_id, agent_id, agent_version_id, initiated_by, trigger) values ($1,$2,$3,$4,$5,'chat') returning id`,
      [t.orgId, conv.id, agent.id, v.id, t.userId],
    );
    const files = await loadAttachments(q, attachmentIds);
    if (files.length !== new Set(attachmentIds).size) throw notFound('Attachment');
    const kIds = [...new Set(input.knowledge)];
    if (kIds.length && !can(t.role, 'memory.read')) throw forbidden('memory.read');
    // RLS hides other people's private entries, so an id that is not theirs to read is simply "not found".
    const knowledge = kIds.length
      ? await q.many<{ id: string; title: string; status: string }>(
          `select id, coalesce(title, left(content, 80)) as title, status from memory_records where id = any($1::uuid[]) and deleted_at is null`,
          [kIds],
        )
      : [];
    if (knowledge.length !== kIds.length) throw notFound('Knowledge entry');
    const meta = {
      ...(files.length ? { attachments: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, kind: f.extracted?.kind ?? 'document', size: f.size_bytes })) } : {}),
      ...(input.fresh ? { fresh: true } : {}),
      ...(knowledge.length ? { knowledge: knowledge.map((k) => ({ id: k.id, title: k.title, status: k.status })) } : {}),
    };
    const msg = await q.one(`insert into conversation_messages (org_id, conversation_id, role, content, run_id, meta) values ($1,$2,'user',$3,$4,$5) returning id, created_at`, [
      t.orgId,
      conv.id,
      content,
      run!.id,
      JSON.stringify(meta),
    ]);
    if (conv.title === 'New conversation') await q.exec('update conversations set title=$2, updated_at=now() where id=$1', [conv.id, content.slice(0, 60)]);
    return { runId: run!.id, messageId: msg.id, agent: routed };
  });
  return c.json(out, 202);
});

/** M2: what this conversation reused instead of looking up again, and what that saved (measured). */
agentRoutes.get('/conversations/:id/context', async (c) => {
  const t = need(c, 'agents.use');
  const data = await tx(t, async (q) => {
    const conv = await q.one('select id from conversations where id=$1 and user_id=$2 and workspace_id=$3', [c.req.param('id'), t.userId, t.workspaceId]);
    if (!conv) throw notFound('Conversation');
    return ledgerStats(q, conv.id, t.userId);
  });
  return c.json(data);
});

agentRoutes.get('/runs/:id', async (c) => {
  const t = need(c, 'agents.use');
  const data = await tx(t, async (q) => {
    const run = await q.one('select * from agent_runs where id=$1 and initiated_by=$2', [c.req.param('id'), t.userId]);
    if (!run) throw notFound('Run');
    const calls = await q.many(
      `select tc.id, tc.tool, tc.args, tc.risk, tc.policy_decision, tc.status, tc.result_summary, tc.result_refs, tc.created_at, tc.finished_at, tc.resolution,
              tc.reused_context_id is not null as reused, ar.id as approval_id, ar.status as approval_status
         from tool_calls tc left join approval_requests ar on ar.tool_call_id = tc.id where tc.run_id=$1 order by tc.created_at`,
      [run.id],
    );
    // Run 3 / M3: friendly labels for the collapsed trace; arguments are never returned here.
    const title = (tool: string, args: unknown) => {
      try {
        return getTool(tool)?.preview(args as any)?.title;
      } catch {
        return undefined;
      }
    };
    const toolCalls = calls.map(({ args, ...c }: any) => ({ ...c, ...toolLabels(c.tool, title(c.tool, args)) }));
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
  // Commit the intent before the provider call, so an interrupted attempt is visible as "unknown", never re-run.
  const started = await tx(t, (q) => q.one(`update tool_calls set status='executing' where id=$1 and status='waiting_approval' returning id`, [tc.id]));
  if (!started) throw new ApiError(409, 'APPROVAL_ALREADY_DECIDED', 'Already handled', 'This action has already been started.');
  const tracked = await trackExternal(
    () =>
      tx(t, async (q) => {
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
      }),
    { idempotencyKey: `qline-${tc.id}` },
  );
  if (tracked.ok) {
    const out = tracked.value;
    return { status: out.ok ? 'executed' : 'failed', result: out, approval: { id: a.id, status: out.ok ? 'executed' : 'failed' } };
  }
  const outcome = tracked.outcome;
  await withTenant({ orgId: t.orgId, userId: t.userId }, async (q) => {
    await q.exec(`update tool_calls set status=$2, result_summary=$3, finished_at=now() where id=$1 and status='executing'`, [tc.id, outcome, outcome === 'unknown' ? UNKNOWN_SUMMARY : safeError(tracked.error)]);
    // approval_requests has no "unknown" state: 'failed' there, while the tool call carries the honest outcome.
    await q.exec(`update approval_requests set status='failed' where id=$1`, [a.id]);
    if (run && outcome === 'unknown') {
      await q.exec(`insert into conversation_messages (org_id, conversation_id, role, content, run_id) values ($1,$2,'system_notice',$3,$4)`, [
        t.orgId,
        run.conversation_id,
        `Approved, but Qline could not confirm the result: ${a.preview?.title ?? a.action} may or may not have happened. Check it before trying again.`,
        run.id,
      ]);
    }
  });
  if (outcome === 'unknown') return { status: 'unknown', approval: { id: a.id, status: 'failed' }, toolCall: { id: tc.id, status: 'unknown' }, message: UNKNOWN_SUMMARY };
  throw new ApiError(500, 'ACTION_FAILED', 'The approved action failed', safeError(tracked.error));
}
