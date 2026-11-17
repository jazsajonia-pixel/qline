import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import { ApiError, notFound } from '../core/errors';
import { limitParam, query } from '../core/validate';
import { kick } from './jobs';

/** Runtime ops for owners/admins (failed-jobs view, retry, cancel). RLS keeps every query inside the org. */
export const runtimeRoutes = new Hono<Env>();
const COLS = 'id, kind, status, attempts, max_attempts, run_at, last_error, cancel_requested, created_by, created_at, updated_at, finished_at';

runtimeRoutes.get('/jobs', async (c) => {
  const t = need(c, 'workflows.manage');
  const p = query(c, z.object({ status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled', 'problem']).optional(), limit: limitParam }));
  const items = await tx(t, (q) =>
    q.many(
      `select ${COLS} from jobs where ($1::text is null or status = $1 or ($1 = 'problem' and status in ('failed','dead'))) order by created_at desc limit $2`,
      [p.status ?? null, p.limit],
    ),
  );
  return c.json({ items });
});

runtimeRoutes.get('/jobs/:id', async (c) => {
  const t = need(c, 'workflows.manage');
  const data = await tx(t, async (q) => {
    const j = await q.one(`select ${COLS}, payload, result from jobs where id=$1`, [c.req.param('id')]);
    if (!j) throw notFound('Job');
    const attempts = await q.many('select attempt, worker, started_at, ended_at, outcome, error from job_attempts where job_id=$1 order by attempt', [j.id]);
    return { ...j, attempts };
  });
  return c.json(data);
});

/** Re-queues a failed or dead job with 3 more attempts. Handlers re-check state, so this cannot skip an approval. */
runtimeRoutes.post('/jobs/:id/retry', async (c) => {
  const t = need(c, 'workflows.manage');
  const row = await tx(t, async (q) => {
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
