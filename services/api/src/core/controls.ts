import type { Q } from './db';
import { AUTONOMY_LEVELS, DEFAULT_DAILY_EXTERNAL_LIMIT, type Autonomy } from '@qline/policy';

export interface WorkspaceControls {
  workspace_id: string;
  paused: boolean;
  emergency_stop: boolean;
  max_parallel_tasks: number;
  updated_by: string | null;
  updated_at: string | null;
}

/** v1.5 workspace controls (docs/13 §8). A missing row means the defaults: running, no stop, 3 parallel tasks. */
export async function getControls(q: Q, workspaceId: string, opts: { lock?: boolean } = {}): Promise<WorkspaceControls> {
  const row = await q.one<WorkspaceControls>(`select * from workspace_controls where workspace_id=$1${opts.lock ? ' for update' : ''}`, [workspaceId]);
  return row ?? { workspace_id: workspaceId, paused: false, emergency_stop: false, max_parallel_tasks: 3, updated_by: null, updated_at: null };
}

/** True when the workspace emergency stop is on: every agent, workflow and mission tool is denied. */
export async function isStopped(q: Q, workspaceId: string): Promise<boolean> {
  const row = await q.one<{ emergency_stop: boolean }>('select emergency_stop from workspace_controls where workspace_id=$1', [workspaceId]);
  return row?.emergency_stop === true;
}

/** v1.6: the workspace's autonomy level and whether today's external-action allowance is used up. */
export async function autonomyState(q: Q, config: any): Promise<{ autonomy: Autonomy; externalCapReached: boolean; dailyExternalLimit: number; externalToday: number }> {
  const ap = config?.agentPolicy ?? {};
  const autonomy: Autonomy = AUTONOMY_LEVELS.includes(ap.autonomy) ? ap.autonomy : 'supervised';
  const limit = Number.isInteger(ap.dailyExternalLimit) ? Math.max(0, Math.min(200, ap.dailyExternalLimit)) : DEFAULT_DAILY_EXTERNAL_LIMIT;
  if (autonomy !== 'full') return { autonomy, externalCapReached: false, dailyExternalLimit: limit, externalToday: 0 };
  // Only actions autopilot let through count; human-approved ones do not use the allowance.
  const r = await q.one<{ n: number }>(
    `select count(*)::int as n from tool_calls where risk='L3' and policy_decision='allow' and status in ('executing','succeeded') and created_at > now() - interval '24 hours'`,
  );
  const n = r?.n ?? 0;
  return { autonomy, externalCapReached: n >= limit, dailyExternalLimit: limit, externalToday: n };
}
