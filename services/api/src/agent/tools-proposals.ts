import { z } from 'zod';
import { TOOL_POLICIES } from '@qline/policy';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { fail } from './tools-apps';
import { checkAllowlist, loadAgent } from './versions';
import type { ToolDef } from './tools';

/**
 * Personal AI OS phase 6 (M8): the model can propose a mission or a change to an agent. A proposal is only a draft
 * in `ai_proposals`; nothing changes until a person approves it in the app, and applying runs through the same
 * permission-checked code as the human routes (modules/proposals.ts). Schemas are strict: anything outside the
 * supported fields (security, billing, keys, members, approval rules, budgets of an agent) is refused.
 */

const SPECIALISTS = ['sales', 'marketing', 'finance', 'operations', 'research'] as const;
const line = z.string().trim().min(1).max(300);

export const MISSION_PROPOSAL = z
  .object({
    title: z.string().trim().min(3).max(120),
    purpose: z.string().trim().min(3).max(2000).describe('What the mission should achieve, in the user’s words'),
    scope: z.string().trim().max(1000).optional(),
    constraints: z.array(line).max(10).optional(),
    successCriteria: z.array(line).max(10).optional(),
    timing: z.string().trim().max(200).optional().describe('When the user wants it done; informational, missions do not run on a schedule'),
    agents: z.array(z.enum(SPECIALISTS)).max(5).optional().describe('Specialists the plan should prefer'),
    budgetTokens: z.number().int().min(1000).max(2_000_000).optional(),
    budgetToolCalls: z.number().int().min(1).max(500).optional(),
    budgetWallSeconds: z.number().int().min(60).max(86_400).optional(),
    maxParallel: z.number().int().min(1).max(4).optional(),
  })
  .strict();
export type MissionProposal = z.infer<typeof MISSION_PROPOSAL>;

export const AGENT_CHANGE = z
  .object({
    agentId: z.string().uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    instructions: z.string().trim().min(1).max(8000).optional(),
    addTools: z.array(z.string().max(60)).max(20).optional(),
    removeTools: z.array(z.string().max(60)).max(40).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type AgentChange = z.infer<typeof AGENT_CHANGE>;
/** What the model sends: the agent by name (or id); the stored proposal keeps the resolved id. */
const AGENT_CHANGE_TOOL = AGENT_CHANGE.omit({ agentId: true }).extend({ agent: z.string().trim().min(1).max(80).describe('Agent name, for example "Sales" or "Inbox helper"') }).strict();

/** The goal text a mission planner receives (POST /missions takes a single goal). */
export function missionGoal(p: MissionProposal) {
  const list = (h: string, xs?: string[]) => (xs?.length ? `\n${h}:\n${xs.map((x) => `- ${x}`).join('\n')}` : '');
  return [
    `${p.title}\n\n${p.purpose}`,
    p.scope ? `\nScope: ${p.scope}` : '',
    list('Constraints', p.constraints),
    list('Success criteria', p.successCriteria),
    p.agents?.length ? `\nPrefer these specialists: ${p.agents.join(', ')}` : '',
    p.timing ? `\nTiming: ${p.timing}` : '',
  ]
    .join('')
    .slice(0, 4000);
}

/** Current agent settings and what the change would make them, plus whether it widens what the agent may do. */
export async function agentDiff(q: Q, p: AgentChange) {
  const a = await loadAgent(q, p.agentId);
  if (!a || a.status === 'archived') return null;
  const before = { name: a.name as string, description: (a.description as string | null) ?? null, instructions: a.instructions as string, tools: [...(a.tool_allowlist as string[])].sort() };
  const tools = [...new Set([...before.tools.filter((t) => !(p.removeTools ?? []).includes(t)), ...(p.addTools ?? [])])].sort();
  const after = { name: p.name ?? before.name, description: p.description ?? before.description, instructions: p.instructions ?? before.instructions, tools };
  const added = tools.filter((t) => !before.tools.includes(t));
  const sensitive = added.filter((t) => (TOOL_POLICIES[t]?.risk ?? 'L4') >= 'L2' || TOOL_POLICIES[t]?.decision !== 'allow');
  return { agent: a, before, after, added, removed: before.tools.filter((t) => !tools.includes(t)), sensitive };
}

const insert = (q: Q, ctx: { orgId: string; workspaceId: string; actor: { kind: string; id: string }; userId: string }, kind: string, title: string, payload: unknown, targetRef: string | null) =>
  q.one<{ id: string }>(
    `insert into ai_proposals (org_id, workspace_id, kind, title, payload, target_ref, proposed_by, proposed_for) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.orgId, ctx.workspaceId, kind, title, JSON.stringify(payload), targetRef, `${ctx.actor.kind}:${ctx.actor.id}`, ctx.userId],
  );

export const proposalTools = {
  'missions.propose': {
    description:
      'Propose a mission for the user to review in the Missions screen (title, purpose, scope, constraints, success criteria, preferred specialists, budget). Nothing starts until the user approves it there. Use when the user asks you to set up, plan or start a mission or a multi-step project.',
    schema: MISSION_PROPOSAL,
    async execute(q, ctx, a) {
      const r = await insert(q, ctx, 'mission', a.title, a, null);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'proposal.created', targetRef: `proposal:${r!.id}`, detail: { kind: 'mission' } });
      return {
        ok: true,
        summary: `Proposed the mission “${a.title}”. It is waiting for the user’s review in Missions; nothing has started.`,
        refs: [{ type: 'proposal', id: r!.id, title: a.title }],
        artifacts: [{ type: 'proposal', id: r!.id, kind: 'mission', title: a.title }],
      };
    },
    preview: (a) => ({ title: 'Propose a mission', lines: [a.title, a.purpose.slice(0, 200)] }),
  } satisfies ToolDef<typeof MISSION_PROPOSAL>,

  'agents.propose_change': {
    description:
      'Propose a change to one agent’s name, description, instructions or tools. The user reviews a before/after view and approves or rejects it. You cannot change approval rules, budgets, AI keys, members, billing or security settings.',
    schema: AGENT_CHANGE_TOOL,
    async execute(q, ctx, input) {
      const { agent, ...rest } = input;
      const found = await q.many<{ id: string }>(`select id from agents where status <> 'archived' and (id::text = $1 or lower(name) = lower($1) or template = lower($1)) limit 2`, [agent]);
      if (found.length !== 1) return fail(found.length ? `More than one agent matches “${agent}”; use its exact name.` : `No agent called “${agent}”.`);
      const a: AgentChange = { agentId: found[0]!.id, ...rest };
      if (!a.name && a.description === undefined && !a.instructions && !a.addTools?.length && !a.removeTools?.length) return fail('Nothing to change: say which setting should change.');
      const d = await agentDiff(q, a);
      if (!d) return fail('That agent was not found.');
      try {
        checkAllowlist(d.agent, d.after.tools);
      } catch (e) {
        return fail(`Cannot propose that: ${(e as Error).message}`);
      }
      const title = `Change ${d.agent.name}`;
      const r = await insert(q, ctx, 'agent_change', title, a, `agent:${a.agentId}`);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'proposal.created', targetRef: `proposal:${r!.id}`, detail: { kind: 'agent_change', agent: a.agentId, added: d.added, removed: d.removed } });
      return {
        ok: true,
        summary: `Proposed a change to ${d.agent.name}${d.sensitive.length ? ` (adds tools that need care: ${d.sensitive.join(', ')})` : ''}. Waiting for the user’s review; nothing changed yet.`,
        refs: [{ type: 'proposal', id: r!.id, title }],
        artifacts: [{ type: 'proposal', id: r!.id, kind: 'agent_change', title }],
      };
    },
    preview: (a) => ({ title: 'Propose an agent change', lines: [a.agent, a.reason ?? ''] }),
  } satisfies ToolDef<typeof AGENT_CHANGE_TOOL>,
};
