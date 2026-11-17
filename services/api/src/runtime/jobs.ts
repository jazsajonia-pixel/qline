/**
 * v1.4 Durable Automation Runtime (docs/12). Postgres jobs with leases, fencing,
 * retries with backoff, a dead-letter state and cooperative cancellation.
 *
 * Rules:
 * - Enqueue inside the caller's transaction, so a job exists if and only if the business change committed.
 * - Handlers must be replay-safe: a job can run more than once (lease expiry, crash).
 *   Key side effects by stable keys (e.g. `wf:<run>:<step>`), never by attempt number.
 */
import { randomBytes } from 'node:crypto';
import { getPool, withTenant, type Q } from '../core/db';

export interface EnqueueInput {
  orgId: string;
  kind: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  parentId?: string;
  groupId?: string;
  deadlineAt?: Date;
  createdBy: string;
}

/** Inserts a job in the current tenant transaction. Returns its id, or the existing id for a duplicate idempotency key. */
export async function enqueue(q: Q, j: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const row = await q.one<{ id: string }>(
    `insert into jobs (org_id, kind, payload, idempotency_key, run_at, priority, max_attempts, parent_id, group_id, deadline_at, created_by)
     values ($1,$2,$3,$4,coalesce($5, now()),$6,$7,$8,$9,$10,$11)
     on conflict (org_id, kind, idempotency_key) where idempotency_key is not null do nothing returning id`,
    [
      j.orgId,
      j.kind,
      JSON.stringify(j.payload ?? {}),
      j.idempotencyKey ?? null,
      j.runAt ?? null,
      j.priority ?? 0,
      j.maxAttempts ?? 5,
      j.parentId ?? null,
      j.groupId ?? null,
      j.deadlineAt ?? null,
      j.createdBy,
    ],
  );
  if (row) return { id: row.id, created: true };
  const existing = await q.one<{ id: string }>('select id from jobs where org_id=$1 and kind=$2 and idempotency_key=$3', [j.orgId, j.kind, j.idempotencyKey]);
  return { id: existing!.id, created: false };
}

/** Thrown by a handler for errors that retrying cannot fix (bad input, permission). */
export class PermanentError extends Error {
  readonly permanent = true;
}
/** Thrown inside a handler when the worker no longer holds the job (another worker reclaimed it). */
export class LeaseLostError extends Error {}
/** Thrown inside a handler when the job was cancelled. */
export class CancelledError extends Error {}

export function backoffMs(attempt: number, baseMs = 5_000, maxMs = 15 * 60_000, rand = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.8 + rand() * 0.4)); // ±20% jitter so retries do not stampede
}

export interface ClaimedJob {
  id: string;
  org_id: string;
  kind: string;
  payload: any;
  attempts: number;
  max_attempts: number;
  idempotency_key: string | null;
  created_by: string;
  deadline_at: string | null;
}

export interface JobCtx {
  job: ClaimedJob;
  worker: string;
  /** Extends the lease. Throws LeaseLostError when fenced out, CancelledError when cancel was requested. */
  heartbeat(): Promise<void>;
  /** Aborted on cancel or lease loss (best effort, checked at heartbeats). */
  signal: AbortSignal;
}
export type JobHandler = (ctx: JobCtx) => Promise<unknown>;

export interface JobOptions {
  /** Called once when the job ends as failed or dead, so domain state never looks "still running". */
  onGiveUp?: (job: ClaimedJob, error: string) => Promise<void>;
}
const handlers = new Map<string, JobHandler>();
const options = new Map<string, JobOptions>();
export const getHandler = (kind: string) => handlers.get(kind);

export function registerJob(kind: string, h: JobHandler, opts: JobOptions = {}) {
  handlers.set(kind, h);
  options.set(kind, opts);
}
export function registeredKinds() {
  return [...handlers.keys()];
}

export const LEASE_SECONDS = 60;

export function workerId(prefix = 'fn') {
  return `${prefix}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

async function sys<T>(text: string, params: unknown[]): Promise<T[]> {
  // Worker functions are SECURITY DEFINER and tenant-agnostic; no RLS context needed.
  return withTenant({ orgId: null, userId: 'system:runtime' }, (q) => q.many<T>(text, params));
}

export async function claim(worker: string, limit: number, leaseSeconds = LEASE_SECONDS): Promise<ClaimedJob[]> {
  return sys<ClaimedJob>('select * from qline_claim_jobs($1,$2,$3)', [worker, limit, leaseSeconds]);
}

export async function finish(job: ClaimedJob, worker: string, outcome: 'succeeded' | 'retry' | 'failed' | 'dead' | 'cancelled', error?: string, result?: unknown, retryAt?: Date) {
  const r = await sys<{ ok: boolean }>('select qline_job_finish($1,$2,$3,$4,$5,$6,$7) as ok', [
    job.id,
    worker,
    job.attempts,
    outcome,
    error ?? null,
    result === undefined ? null : JSON.stringify(result ?? null),
    retryAt ?? null,
  ]);
  return r[0]?.ok === true;
}

export async function runOne(job: ClaimedJob, worker: string): Promise<'succeeded' | 'retry' | 'failed' | 'dead' | 'cancelled' | 'fenced'> {
  const h = handlers.get(job.kind);
  const ac = new AbortController();
  const ctx: JobCtx = {
    job,
    worker,
    signal: ac.signal,
    async heartbeat() {
      const r = await sys<{ c: boolean | null }>('select qline_job_heartbeat($1,$2,$3,$4) as c', [job.id, worker, job.attempts, LEASE_SECONDS]);
      const c = r[0]?.c;
      if (c === null || c === undefined) {
        ac.abort();
        throw new LeaseLostError('Lease lost');
      }
      if (c) {
        ac.abort();
        throw new CancelledError('Cancelled');
      }
    },
  };
  let outcome: 'succeeded' | 'retry' | 'failed' | 'dead' | 'cancelled';
  let error: string | undefined;
  let result: unknown;
  let retryAt: Date | undefined;
  if (!h) {
    outcome = 'failed';
    error = `No handler for ${job.kind}`;
  } else if (job.deadline_at && new Date(job.deadline_at) < new Date()) {
    outcome = 'failed';
    error = 'Deadline passed before the job could run';
  } else {
    try {
      result = await h(ctx);
      outcome = 'succeeded';
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      if (e instanceof LeaseLostError) return 'fenced';
      if (e instanceof CancelledError) outcome = 'cancelled';
      else if ((e as any)?.permanent) outcome = 'failed';
      else if (job.attempts >= job.max_attempts) outcome = 'dead';
      else {
        outcome = 'retry';
        retryAt = new Date(Date.now() + backoffMs(job.attempts));
      }
    }
  }
  const ok = await finish(job, worker, outcome, error, result, retryAt);
  if (ok && (outcome === 'failed' || outcome === 'dead')) {
    await options.get(job.kind)?.onGiveUp?.(job, error ?? 'unknown error').catch((e) => console.error('onGiveUp failed', job.kind, (e as Error).message));
  }
  return ok ? outcome : 'fenced';
}

export interface DrainResult {
  claimed: number;
  outcomes: Record<string, number>;
  stoppedBy: 'empty' | 'budget' | 'paused' | 'max';
}

/**
 * Claims and runs jobs until the queue is empty or the time budget is used.
 * Never idles: an empty claim ends the drain (keeps the free-plan waiting hours low).
 */
export async function drain(opts: { worker?: string; budgetMs: number; concurrency?: number; maxJobs?: number }): Promise<DrainResult> {
  const worker = opts.worker ?? workerId();
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 4)); // pg pool max is 5
  const maxJobs = opts.maxJobs ?? 500;
  const started = Date.now();
  const out: DrainResult = { claimed: 0, outcomes: {}, stoppedBy: 'empty' };
  if (process.env.QLINE_RUNTIME_PAUSED === '1') return { ...out, stoppedBy: 'paused' };
  while (true) {
    if (Date.now() - started > opts.budgetMs) {
      out.stoppedBy = 'budget';
      break;
    }
    if (out.claimed >= maxJobs) {
      out.stoppedBy = 'max';
      break;
    }
    const jobs = await claim(worker, concurrency);
    if (!jobs.length) break;
    out.claimed += jobs.length;
    const results = await Promise.all(jobs.map((j) => runOne(j, worker).catch((e) => (console.error('job runner error', j.kind, (e as Error).message), 'fenced' as const))));
    for (const r of results) out.outcomes[r] = (out.outcomes[r] ?? 0) + 1;
  }
  return out;
}

/** Claims one specific job right now (inline fast path). Returns null if another worker has it or it is not due. */
export async function claimById(jobId: string, worker: string): Promise<ClaimedJob | null> {
  const r = await sys<ClaimedJob>('select * from qline_claim_job_by_id($1,$2,$3)', [jobId, worker, LEASE_SECONDS]);
  return r[0] ?? null;
}

/** Runs a just-enqueued job inline (keeps request/response UX); if the process dies, a tick recovers it via the lease. */
export async function runInline(jobId: string) {
  const worker = workerId('inline');
  const job = await claimById(jobId, worker);
  if (!job) return null;
  return runOne(job, worker);
}

// ---- Kick: best-effort fast path after a request enqueues work ----------------
let kicking: Promise<unknown> | null = null;
let rekick = false;
const pending = new Set<Promise<unknown>>();
export function kick(budgetMs = 20_000) {
  if (process.env.QLINE_RUNTIME_KICK === '0') return;
  if (kicking) {
    rekick = true; // the running drain may already have seen an empty queue; go again when it ends
    return;
  }
  rekick = false;
  const p = drain({ worker: workerId('kick'), budgetMs })
    .catch((e) => console.error('kick drain failed', (e as Error).message))
    .finally(() => {
      kicking = null;
      pending.delete(p);
      if (rekick) kick(budgetMs);
    });
  kicking = p;
  pending.add(p);
  // Neon keeps the invocation alive until the promise settles (max 15 min); a no-op elsewhere.
  (globalThis as any).NEON_REQUEST_CONTEXT?.waitUntil?.(p);
}
/** Tests: wait for any background kick to finish. */
export async function settleKicks() {
  while (pending.size) await Promise.allSettled([...pending]);
}

export async function runtimeStats() {
  const r = await getPool().query('select * from qline_runtime_stats()');
  return r.rows[0];
}
