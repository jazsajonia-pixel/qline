import { Hono } from 'hono';
import { z } from 'zod';
import { can, type Permission } from '@qline/policy';
import { audit } from '../core/audit';
import { need, tx, type Env, type TenantCtx } from '../core/context';
import { ApiError, conflict, forbidden, notFound } from '../core/errors';
import { body, query } from '../core/validate';
import { kick } from '../runtime/jobs';
import { AGENT_CHANGE, agentDiff, MISSION_PROPOSAL, missionGoal, type AgentChange, type MissionProposal } from '../agent/tools-proposals';
import { createMission } from './missions';
import { updateAgent } from './agents';

/**
 * Personal AI OS phase 6 (M8). AI proposals are reviewed, edited, applied or rejected here, by people only.
 * Applying uses the same functions as POST /missions and PATCH /agents/:id, with the same permission each needs,
 * so a model can never reach a change a person could not make by hand.
 */
export const proposalRoutes = new Hono<Env>();

const APPLY_PERMISSION: Record<string, Permission> = { mission: 'agents.use', agent_change: 'agents.manage' };
const SCHEMA = { mission: MISSION_PROPOSAL, agent_change: AGENT_CHANGE } as const;
const OPEN = ['proposed', 'edited', 'failed'];
const COLS = 'id, kind, title, payload, status, target_ref, applied_ref, error, proposed_by, proposed_for, revision, decided_by, decided_at, created_at, updated_at';

function mustApply(t: TenantCtx, kind: string) {
  const perm = APPLY_PERMISSION[kind];
  if (!perm || !can(t.role, perm)) throw forbidden(`Your role (${t.role}) cannot apply this proposal; it needs ${perm}.`);
}

async function withDiff(q: Parameters<typeof agentDiff>[0], p: any) {
  if (p.kind === 'agent_change') {
    const d = await agentDiff(q, p.payload as AgentChange);
    return { ...p, diff: d ? { agentName: d.agent.name, before: d.before, after: d.after, added: d.added, removed: d.removed, sensitive: d.sensitive } : null };
  }
  return { ...p, goal: missionGoal(p.payload as MissionProposal) };
}

proposalRoutes.get('/proposals', async (c) => {
  const t = need(c, 'agents.use');
  const p = query(c, z.object({ kind: z.enum(['mission', 'agent_change']).optional(), status: z.enum(['open', 'all']).default('open') }));
  const items = await tx(t, (q) =>
    q.many(
      `select ${COLS} from ai_proposals where workspace_id=$1 and ($2::text is null or kind=$2) and ($3 = 'all' or status = any($4::text[])) order by created_at desc limit 50`,
      [t.workspaceId, p.kind ?? null, p.status, OPEN],
    ),
  );
  return c.json({ items });
});

proposalRoutes.get('/proposals/:id', async (c) => {
  const t = need(c, 'agents.use');
  const row = await tx(t, async (q) => {
    const p = await q.one(`select ${COLS} from ai_proposals where id=$1 and workspace_id=$2`, [c.req.param('id'), t.workspaceId]);
    if (!p) throw notFound('Proposal');
    return withDiff(q, p);
  });
  return c.json({ ...row, canApply: can(t.role, APPLY_PERMISSION[row.kind]!) });
});

/** A person edits the proposal before deciding. The payload is validated with the same strict schema as the tool. */
proposalRoutes.patch('/proposals/:id', async (c) => {
  const t = need(c, 'agents.use');
  const input = await body(c, z.object({ revision: z.number().int().min(1), payload: z.record(z.string(), z.unknown()) }));
  const row = await tx(t, async (q) => {
    const p = await q.one<any>(`select ${COLS} from ai_proposals where id=$1 and workspace_id=$2 for update`, [c.req.param('id'), t.workspaceId]);
    if (!p) throw notFound('Proposal');
    mustApply(t, p.kind);
    if (!OPEN.includes(p.status)) throw conflict('PROPOSAL_CLOSED', `This proposal was already ${p.status}.`);
    if (p.revision !== input.revision) throw conflict('STALE_REVISION', 'Someone changed this proposal. Reload and try again.');
    const parsed = SCHEMA[p.kind as keyof typeof SCHEMA].safeParse(input.payload);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid proposal', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    if (p.kind === 'agent_change' && (parsed.data as AgentChange).agentId !== p.payload.agentId) throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid proposal', 'The agent of a proposal cannot change.');
    const title = p.kind === 'mission' ? (parsed.data as MissionProposal).title : p.title;
    const u = await q.one(
      `update ai_proposals set payload=$2, title=$3, status='edited', revision=revision+1, error=null, updated_at=now() where id=$1 returning ${COLS}`,
      [p.id, JSON.stringify(parsed.data), title],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'proposal.edited', targetRef: `proposal:${p.id}`, detail: { kind: p.kind } });
    return withDiff(q, u);
  });
  return c.json(row);
});

proposalRoutes.post('/proposals/:id/apply', async (c) => {
  const t = need(c, 'agents.use');
  const input = await body(c, z.object({ revision: z.number().int().min(1) }));
  const id = c.req.param('id');
  let applying = false;
  try {
    const row = await tx(t, async (q) => {
      const p = await q.one<any>(`select ${COLS} from ai_proposals where id=$1 and workspace_id=$2 for update`, [id, t.workspaceId]);
      if (!p) throw notFound('Proposal');
      mustApply(t, p.kind);
      if (!OPEN.includes(p.status)) throw conflict('PROPOSAL_CLOSED', `This proposal was already ${p.status}.`);
      if (p.revision !== input.revision) throw conflict('STALE_REVISION', 'This proposal changed since you opened it. Review it again.');
      let applied: string;
      applying = true;
      if (p.kind === 'mission') {
        const m = MISSION_PROPOSAL.parse(p.payload);
        const mission = await createMission(q, t, { goal: missionGoal(m), budgetTokens: m.budgetTokens, budgetToolCalls: m.budgetToolCalls, budgetWallSeconds: m.budgetWallSeconds, maxParallel: m.maxParallel }, `proposal:${p.id}`);
        applied = `mission:${mission.id}`;
      } else {
        const ch = AGENT_CHANGE.parse(p.payload);
        const d = await agentDiff(q, ch);
        if (!d) throw notFound('Agent');
        const a = await updateAgent(
          q,
          t,
          ch.agentId,
          {
            name: ch.name,
            description: ch.description,
            instructions: ch.instructions,
            toolAllowlist: ch.addTools?.length || ch.removeTools?.length ? d.after.tools : undefined,
          },
          `proposal:${p.id}`,
        );
        applied = `agent:${a.id}@v${a.current_version}`;
      }
      const u = await q.one(
        `update ai_proposals set status='applied', applied_ref=$2, error=null, decided_by=$3, decided_at=now(), updated_at=now() where id=$1 returning ${COLS}`,
        [p.id, applied, `user:${t.userId}`],
      );
      await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'proposal.applied', targetRef: `proposal:${p.id}`, detail: { kind: p.kind, applied } });
      return u;
    });
    kick();
    return c.json(row);
  } catch (e) {
    // A change that could not be made (emergency stop on, a tool the agent may no longer have, an archived agent)
    // is recorded as failed so the person sees why and can edit or retry. Permission, state and revision checks
    // happen before `applying` and leave the proposal untouched.
    if (applying && e instanceof ApiError) {
      await tx(t, async (q) => {
        await q.exec(`update ai_proposals set status='failed', error=$2, updated_at=now() where id=$1 and status = any($3::text[])`, [id, e.detail ?? e.title, OPEN]);
        await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'proposal.failed', targetRef: `proposal:${id}`, detail: { code: e.code } });
      });
    }
    throw e;
  }
});

proposalRoutes.post('/proposals/:id/reject', async (c) => {
  const t = need(c, 'agents.use');
  const input = await body(c, z.object({ note: z.string().trim().max(500).optional() }));
  const row = await tx(t, async (q) => {
    const p = await q.one<any>(`select ${COLS} from ai_proposals where id=$1 and workspace_id=$2 for update`, [c.req.param('id'), t.workspaceId]);
    if (!p) throw notFound('Proposal');
    if (!OPEN.includes(p.status)) throw conflict('PROPOSAL_CLOSED', `This proposal was already ${p.status}.`);
    const u = await q.one(`update ai_proposals set status='rejected', error=$2, decided_by=$3, decided_at=now(), updated_at=now() where id=$1 returning ${COLS}`, [p.id, input.note ?? null, `user:${t.userId}`]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'proposal.rejected', targetRef: `proposal:${p.id}`, detail: { kind: p.kind } });
    return u;
  });
  return c.json(row);
});
