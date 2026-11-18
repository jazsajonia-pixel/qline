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

/** Rolling window for the full-autopilot allowance. Timezone-independent: "the last 24 hours", not a calendar day. */
export const EXTERNAL_WINDOW = "interval '24 hours'";

function limitFrom(config: any): { autonomy: Autonomy; limit: number } {
  const ap = config?.agentPolicy ?? {};
  const autonomy: Autonomy = AUTONOMY_LEVELS.includes(ap.autonomy) ? ap.autonomy : 'supervised';
  const limit = Number.isInteger(ap.dailyExternalLimit) ? Math.max(0, Math.min(200, ap.dailyExternalLimit)) : DEFAULT_DAILY_EXTERNAL_LIMIT;
  return { autonomy, limit };
}

async function usedInWindow(q: Q, workspaceId: string): Promise<number> {
  const r = await q.one<{ n: number }>(
    `select count(*)::int as n from external_action_reservations where workspace_id=$1 and status <> 'released' and created_at > now() - ${EXTERNAL_WINDOW}`,
    [workspaceId],
  );
  return r?.n ?? 0;
}

/**
 * The workspace's autonomy level and how much of its full-autopilot allowance is used (M1, docs/17 §A).
 * This is a display / pre-check only: the binding check is `reserveExternalAction`, which is atomic.
 */
export async function autonomyState(q: Q, config: any, workspaceId: string): Promise<{ autonomy: Autonomy; externalCapReached: boolean; dailyExternalLimit: number; externalToday: number }> {
  const { autonomy, limit } = limitFrom(config);
  if (autonomy !== 'full') return { autonomy, externalCapReached: false, dailyExternalLimit: limit, externalToday: 0 };
  // Only actions autopilot let through count; human-approved ones do not use the allowance.
  const n = await usedInWindow(q, workspaceId);
  return { autonomy, externalCapReached: n >= limit, dailyExternalLimit: limit, externalToday: n };
}

/**
 * Atomically reserves one full-autopilot external action for this workspace. Concurrent callers serialize on a
 * per-workspace transaction-scoped advisory lock, so two workers can never both take the last slot. The limit is
 * re-read from the workspace config under the lock. Commit the surrounding transaction BEFORE calling the provider.
 * Returns false when the allowance is used up (the caller must then ask a human instead).
 */
export async function reserveExternalAction(q: Q, x: { orgId: string; workspaceId: string; toolCallId: string; tool: string }): Promise<boolean> {
  await q.exec(`select pg_advisory_xact_lock(hashtextextended('qline.external_cap:' || $1::text, 0))`, [x.workspaceId]);
  const ws = await q.one('select config from workspaces where id=$1', [x.workspaceId]);
  const { autonomy, limit } = limitFrom(ws?.config);
  if (autonomy !== 'full') return false;
  if ((await usedInWindow(q, x.workspaceId)) >= limit) return false;
  await q.exec(
    `insert into external_action_reservations (org_id, workspace_id, tool_call_id, tool) values ($1,$2,$3,$4) on conflict (org_id, tool_call_id) do nothing`,
    [x.orgId, x.workspaceId, x.toolCallId, x.tool],
  );
  return true;
}

/**
 * Settles a reservation once the outcome is known. Only a definite failure (nothing happened) gives the slot back;
 * success and unknown outcomes keep it used. A crashed attempt's slot stays reserved (counted) until the reconciler
 * marks it consumed, so a crash can never free capacity it may have used.
 */
export async function settleReservation(q: Q, toolCallId: string, outcome: 'succeeded' | 'failed' | 'unknown'): Promise<void> {
  await q.exec(`update external_action_reservations set status=$2, settled_at=now() where tool_call_id=$1 and status='reserved'`, [toolCallId, outcome === 'failed' ? 'released' : 'consumed']);
}
