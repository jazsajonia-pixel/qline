import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import { ApiError, notFound } from '../core/errors';
import { limitParam, query } from '../core/validate';
import type { Q } from '../core/db';
import { getHandler, kick } from './jobs';

/** Runtime ops for owners/admins (failed-jobs view, retry, cancel). RLS keeps every query inside the org. */
export const runtimeRoutes = new Hono<Env>();
const COLS = "id, kind, status, attempts, max_attempts, run_at, last_error, cancel_requested, created_by, created_at, updated_at, finished_at, payload->>'runId' as run_id";

/**
 * Whether retrying a job is safe (M5). Every registered handler re-reads state and external sends are guarded by
 * intent records, so a retry never repeats a send. A workflow step whose outcome is unknown is NOT a job retry:
 * a person must say whether it happened (POST /workflow-runs/:id/resolve).
 */
async function retrySafety(q: Q, j: any): Promise<{ retry_safe: boolean; retry_note: string }> {
  if (j.kind === 'workflow.advance' && j.run_id) {
    const r = await q.one('select status, current_step from workflow_runs where id=$1', [j.run_id]);
    if (r) {
      const u = await q.one(`select 1 from tool_calls where idempotency_key=$1 and status in ('unknown','executing')`, [`wf:${j.run_id}:${r.current_step}`]);
      if (u) return { retry_safe: false, retry_note: 'An external action may or may not have happened. Open the run and say whether it did.' };
      if (['completed', 'cancelled', 'failed', 'rejected'].includes(r.status)) return { retry_safe: false, retry_note: `The run is already ${r.status}; there is nothing to retry.` };
    }
    return { retry_safe: true, retry_note: 'Safe to retry: the run continues from its current step and re-checks approvals.' };
  }
  if (!getHandler(j.kind)) return { retry_safe: false, retry_note: 'No handler for this job type; retrying would fail again.' };
  return { retry_safe: true, retry_note: 'Safe to retry: this job re-checks state and does not repeat sends.' };
}


runtimeRoutes.get('/jobs', async (c) => {
  const t = need(c, 'workflows.manage');
  const p = query(c, z.object({ status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled', 'problem', 'active']).optional(), limit: limitParam }));
  const items = await tx(t, async (q) => {
    const rows = await q.many(
      `select ${COLS} from jobs where ($1::text is null or status = $1 or ($1 = 'problem' and status in ('failed','dead')) or ($1 = 'active' and status in ('queued','running'))) order by created_at desc limit $2`,
      [p.status ?? null, p.limit],
    );
    for (const j of rows) if (j.status === 'failed' || j.status === 'dead') Object.assign(j, await retrySafety(q, j));
    return rows;
  });
  return c.json({ items });
});

runtimeRoutes.get('/jobs/:id', async (c) => {
  const t = need(c, 'workflows.manage');
  const data = await tx(t, async (q) => {
    const j = await q.one(`select ${COLS}, payload, result from jobs where id=$1`, [c.req.param('id')]);
    if (!j) throw notFound('Job');
    const attempts = await q.many('select attempt, worker, started_at, ended_at, outcome, error from job_attempts where job_id=$1 order by attempt', [j.id]);
    return { ...j, attempts, ...(j.status === 'failed' || j.status === 'dead' ? await retrySafety(q, j) : {}) };
  });
  return c.json(data);
});

/** Re-queues a failed or dead job with 3 more attempts. Handlers re-check state, so this cannot skip an approval. */
runtimeRoutes.post('/jobs/:id/retry', async (c) => {
  const t = need(c, 'workflows.manage');
  const row = await tx(t, async (q) => {
    const cur = await q.one(`select ${COLS} from jobs where id=$1 for update`, [c.req.param('id')]);
    if (!cur) throw notFound('Job');
    if (cur.status !== 'failed' && cur.status !== 'dead') throw new ApiError(409, 'JOB_NOT_RETRYABLE', 'Not retryable', 'Only failed or dead jobs can be retried.');
    const safety = await retrySafety(q, cur);
    if (!safety.retry_safe) throw new ApiError(409, 'RETRY_UNSAFE', 'Check first', safety.retry_note);
    // A dead advance job leaves its run in needs_attention; resume the run too, or the retry would be a no-op.
    if (cur.kind === 'workflow.advance' && cur.run_id)
      await q.exec(`update workflow_runs set status='running', error=null where id=$1 and status='needs_attention'`, [cur.run_id]);
    const j = await q.one(
      `update jobs set status='queued', run_at=now(), max_attempts=least(25, attempts + 3), cancel_requested=false, finished_at=null, updated_at=now()
       where id=$1 and status in ('failed','dead') returning ${COLS}`,
      [c.req.param('id')],
    );
    if (!j) throw new ApiError(409, 'JOB_NOT_RETRYABLE', 'Not retryable', 'Only failed or dead jobs can be retried.');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'job.retried', targetRef: `job:${j.id}`, detail: { kind: j.kind } });
    return j;
  });
  kick();
  return c.json(row);
});

runtimeRoutes.post('/jobs/:id/cancel', async (c) => {
  const t = need(c, 'workflows.manage');
  const row = await tx(t, async (q) => {
    const j = await q.one(
      `update jobs set cancel_requested=true, status = case when status='queued' then 'cancelled' else status end,
              finished_at = case when status='queued' then now() else finished_at end, updated_at=now()
       where id=$1 and status in ('queued','running') returning ${COLS}`,
      [c.req.param('id')],
    );
    if (!j) throw new ApiError(409, 'JOB_FINISHED', 'Already finished', 'Only queued or running jobs can be cancelled.');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'job.cancelled', targetRef: `job:${j.id}`, detail: { kind: j.kind } });
    return j;
  });
  return c.json(row);
});
