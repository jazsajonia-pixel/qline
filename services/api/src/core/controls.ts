import type { Q } from './db';

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
