import { TOOL_POLICIES, type AgentTemplate } from '@qline/policy';
import type { Q } from '../core/db';
import { ApiError, forbidden } from '../core/errors';

/** Every versioned agent setting. A change to any of them is a new agent_versions row (history + revert). */
export interface VersionFields {
  instructions: string;
  model: string;
  provider: string | null;
  tool_allowlist: string[];
  key_id: string | null;
  approval_mode: 'policy' | 'ask_all';
  max_tool_calls: number;
  daily_runs: number | null;
  max_concurrent: number | null;
}

export const VERSION_COLS = 'v.instructions, v.model, v.provider, v.tool_allowlist, v.key_id, v.approval_mode, v.max_tool_calls, v.daily_runs, v.max_concurrent';

/** Loads an agent with its current version (RLS-scoped). */
export async function loadAgent(q: Q, id: string) {
  return q.one<any>(`select a.*, ${VERSION_COLS} from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version where a.id=$1`, [id]);
}

/** The built-in profile whose tool entitlements bound this agent (custom agents: the one they are based on). */
export const entitlement = (a: { template: string; based_on?: string | null }): AgentTemplate => (a.template === 'custom' ? (a.based_on as AgentTemplate) : (a.template as AgentTemplate));

/** Tools must be ones this agent's profile is entitled to (policy floor); never widened by a person or a model. */
export function checkAllowlist(a: { template: string; based_on?: string | null }, tools: readonly string[]) {
  const profile = entitlement(a);
  for (const tool of tools) {
    const p = TOOL_POLICIES[tool];
    if (!p || !p.templates.includes(profile)) throw forbidden(`${tool} is not available to agents based on the ${profile} profile.`);
  }
}

/** Least privilege for a new custom agent: only the read-only (L0) tools of its profile. */
export function readOnlyTools(profile: AgentTemplate) {
  return Object.entries(TOOL_POLICIES)
    .filter(([, p]) => p.templates.includes(profile) && p.risk === 'L0')
    .map(([n]) => n);
}

/** Checks that a key assignment belongs to the agent's provider. */
export async function checkKey(q: Q, orgId: string, provider: string | null, keyId: string | null) {
  if (!keyId) return;
  if (!provider) throw new ApiError(400, 'AI_KEY_NEEDS_PROVIDER', 'Pick a provider and model for this agent before assigning a key');
  const k = await q.one('select provider from ai_keys where id=$1 and org_id=$2', [keyId, orgId]);
  if (!k) throw new ApiError(404, 'AI_KEY_NOT_FOUND', 'That key no longer exists');
  if (k.provider !== provider) throw new ApiError(400, 'AI_KEY_WRONG_PROVIDER', 'That key belongs to a different provider than the agent uses');
}

/** Writes the next version with `changes` over the current one and points the agent at it. Returns the new number. */
export async function newVersion(q: Q, orgId: string, a: any, changes: Partial<VersionFields>, by: string): Promise<number> {
  const f: VersionFields = {
    instructions: a.instructions,
    model: a.model,
    provider: a.provider ?? null,
    tool_allowlist: a.tool_allowlist,
    key_id: a.key_id ?? null,
    approval_mode: a.approval_mode ?? 'policy',
    max_tool_calls: a.max_tool_calls ?? 8,
    daily_runs: a.daily_runs ?? null,
    max_concurrent: a.max_concurrent ?? null,
    ...changes,
  };
  const next = a.current_version + 1;
  await q.exec(
    `insert into agent_versions (org_id, agent_id, version, instructions, model, provider, tool_allowlist, key_id, approval_mode, max_tool_calls, daily_runs, max_concurrent, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [orgId, a.id, next, f.instructions, f.model, f.provider, f.tool_allowlist, f.key_id, f.approval_mode, f.max_tool_calls, f.daily_runs, f.max_concurrent, by],
  );
  await q.exec('update agents set current_version=$2 where id=$1', [a.id, next]);
  return next;
}
