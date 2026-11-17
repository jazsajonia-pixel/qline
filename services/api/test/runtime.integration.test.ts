/**
 * v1.4 Durable Automation Runtime release gates (docs/12 §9) against a real Postgres.
 * Needs QLINE_TEST_ENV (same as api.integration.test.ts); skipped otherwise.
 * Background kicks are off here so every drain is explicit and deterministic.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';
delete process.env.NEON_AI_GATEWAY_TOKEN;

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let J: typeof import('../src/runtime/jobs');
let db: typeof import('../src/core/db');
let outbox: typeof import('../src/runtime/outbox');
let wfm: typeof import('../src/modules/workflows');

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${who.token}`;
  if (who?.org) headers['x-qline-org'] = who.org;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request(`http://localhost${path.startsWith('/internal') ? '' : '/v1'}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

async function signUp(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, 'POST', '/auth/sign-up/email', { email, password: 'correct-horse-battery', name });
  expect(r.status).toBe(200);
  return { token: r.json.token };
}

const asOrg = <T>(w: Who, fn: (q: import('../src/core/db').Q) => Promise<T>) => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);
const job = (w: Who, id: string) => asOrg(w, (q) => q.one('select * from jobs where id=$1', [id]));
const add = (w: Who, kind: string, payload: Record<string, unknown> = {}, extra: Partial<import('../src/runtime/jobs').EnqueueInput> = {}) =>
  asOrg(w, (q) => J.enqueue(q, { orgId: w.org!, kind, payload, createdBy: 'test', ...extra }));
const dueNow = (w: Who, id: string) => asOrg(w, (q) => q.exec('update jobs set run_at=now() where id=$1', [id]));
const drainAll = () => J.drain({ budgetMs: 20_000 });

// Test-only handlers.
const flakyFails = new Map<string, number>();
const seen = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('Durable runtime (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    J = await import('../src/runtime/jobs');
    db = await import('../src/core/db');
    outbox = await import('../src/runtime/outbox');
    wfm = await import('../src/modules/workflows');
    J.registerJob('test.ok', async ({ job }) => {
      seen.set(job.id, (seen.get(job.id) ?? 0) + 1);
      return { ok: true };
    });
    J.registerJob('test.flaky', async ({ job }) => {
      const left = flakyFails.get(job.id) ?? 0;
      if (left > 0) {
        flakyFails.set(job.id, left - 1);
        throw new Error('temporary failure');
      }
      return { ok: true };
    });
    J.registerJob('test.always', async () => {
      throw new Error('always fails');
    });
    J.registerJob('test.perm', async () => {
      throw new J.PermanentError('bad input');
    });
    J.registerJob('test.slow', async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await sleep(100);
        await ctx.heartbeat();
      }
      return { finished: true };
    });
    A = await signUp('Rita');
    B = await signUp('Ben');
    A.org = (await call(A, 'POST', '/orgs', { name: 'Runtime A' })).json.id;
    B.org = (await call(B, 'POST', '/orgs', { name: 'Runtime B' })).json.id;
    A.userId = (await call(A, 'GET', '/me')).json.user.id;
    B.userId = (await call(B, 'GET', '/me')).json.user.id;
    await drainAll(); // settle anything left by setup
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('enqueue is idempotent per key', async () => {
    const k = `idem:${randomUUID()}`;
    const a = await add(A, 'test.ok', {}, { idempotencyKey: k });
    const b = await add(A, 'test.ok', {}, { idempotencyKey: k });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    await drainAll();
    expect(seen.get(a.id)).toBe(1);
  });

  it('claims are exclusive under concurrency (no job runs twice)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await add(A, 'test.ok')).id);
    const batches = await Promise.all([0, 1, 2, 3].map((i) => J.claim(`w${i}`, 10)));
    const claimed = batches.flat().map((j) => j.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    for (const id of ids) expect(claimed).toContain(id);
    for (const b of batches) for (const j of b) await J.runOne(j, batches.indexOf(b) === -1 ? '' : `w${batches.indexOf(b)}`);
    for (const id of ids) expect(seen.get(id)).toBe(1);
  });

  it('retries with backoff, respects run_at, then succeeds', async () => {
    const { id } = await add(A, 'test.flaky');
    flakyFails.set(id, 1);
    const before = Date.now();
    await drainAll();
    let j = await job(A, id);
    expect(j.status).toBe('queued');
    expect(j.attempts).toBe(1);
    // First retry waits at least 4 s (5 s base, -20% jitter) after the attempt; measured from before the drain so
    // network latency to the DB (Neon) cannot make this flaky. run_at is computed from the worker's clock (this process).
    expect(new Date(j.run_at).getTime()).toBeGreaterThanOrEqual(before + 4_000);
    await drainAll();
    expect((await job(A, id)).attempts).toBe(1); // not due yet
    await dueNow(A, id);
    await drainAll();
    j = await job(A, id);
    expect(j.status).toBe('succeeded');
    expect(j.attempts).toBe(2);
    const att = await asOrg(A, (q) => q.many('select attempt, outcome from job_attempts where job_id=$1 order by attempt', [id]));
    expect(att.map((a: any) => a.outcome)).toEqual(['retry', 'succeeded']);
  });

  it('permanent errors fail at once; exhausted retries go dead', async () => {
    const p = await add(A, 'test.perm');
    await drainAll();
    expect((await job(A, p.id)).status).toBe('failed');
    expect((await job(A, p.id)).attempts).toBe(1);

    const x = await add(A, 'test.always', {}, { maxAttempts: 2 });
    await drainAll();
    await dueNow(A, x.id);
    await drainAll();
    const j = await job(A, x.id);
    expect(j.status).toBe('dead');
    expect(j.last_error).toContain('always fails');
  });

  it('recovers expired leases and fences out the stale worker', async () => {
    const { id } = await add(A, 'test.ok');
    const stale = await J.claimById(id, 'stale-worker');
    expect(stale?.attempts).toBe(1);
    await asOrg(A, (q) => q.exec(`update jobs set lease_until=now() - interval '1 second' where id=$1`, [id]));
    await drainAll(); // another worker reclaims it
    const j = await job(A, id);
    expect(j.status).toBe('succeeded');
    expect(j.attempts).toBe(2);
    expect(await J.finish(stale!, 'stale-worker', 'failed', 'late')).toBe(false); // fenced
    expect((await job(A, id)).status).toBe('succeeded');
    const att = await asOrg(A, (q) => q.many('select attempt, outcome from job_attempts where job_id=$1 order by attempt', [id]));
    expect(att.map((a: any) => a.outcome)).toEqual(['lost', 'succeeded']);
  });

  it('a lost worker on the last attempt ends dead and flags its workflow run', async () => {
    const wf = await call(A, 'POST', '/workflows', { name: 'Lost', definition: { trigger: { type: 'manual' }, steps: [{ type: 'notify', title: 'x' }] } });
    const run = await asOrg(A, (q) =>
      q.one(`insert into workflow_runs (org_id, workflow_id, version, trigger_kind, context, initiated_by, status) values ($1,$2,1,'manual','{}',$3,'running') returning id`, [A.org, wf.json.id, A.userId]),
    );
    const { id } = await add(A, 'workflow.advance', { runId: run.id, workspaceId: wf.json.workspace_id, userId: A.userId }, { maxAttempts: 1 });
    await J.claimById(id, 'doomed');
    await asOrg(A, (q) => q.exec(`update jobs set lease_until=now() - interval '1 second' where id=$1`, [id]));
    await J.claim('sweeper', 1);
    expect((await job(A, id)).status).toBe('dead');
    const r = await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run.id]));
    expect(r.status).toBe('needs_attention');
  });

  it('cancels queued and running jobs; ops can retry dead jobs', async () => {
    const q1 = await add(A, 'test.ok');
    const c1 = await call(A, 'POST', `/jobs/${q1.id}/cancel`);
    expect(c1.status).toBe(200);
    expect(c1.json.status).toBe('cancelled');
    await drainAll();
    expect(seen.get(q1.id)).toBeUndefined();

    const s = await add(A, 'test.slow');
    const running = J.drain({ budgetMs: 20_000, maxJobs: 1 });
    for (let i = 0; i < 50 && (await job(A, s.id)).status !== 'running'; i++) await sleep(50);
    expect((await call(A, 'POST', `/jobs/${s.id}/cancel`)).status).toBe(200);
    const res = await running;
    expect(res.outcomes.cancelled).toBe(1);
    expect((await job(A, s.id)).status).toBe('cancelled');
    expect((await call(A, 'POST', `/jobs/${s.id}/cancel`)).status).toBe(409);

    const dead = await add(A, 'test.always', {}, { maxAttempts: 1 });
    await drainAll();
    expect((await job(A, dead.id)).status).toBe('dead');
    const list = await call(A, 'GET', '/jobs?status=problem');
    expect(list.json.items.map((x: any) => x.id)).toContain(dead.id);
    const rt = await call(A, 'POST', `/jobs/${dead.id}/retry`);
    expect(rt.status).toBe(200);
    expect(rt.json.status).toBe('queued');
    expect(rt.json.max_attempts).toBe(4);
    const detail = await call(A, 'GET', `/jobs/${dead.id}`);
    expect(detail.json.attempts.length).toBe(1);
    await asOrg(A, (q) => q.exec(`update jobs set status='cancelled', finished_at=now() where id=$1`, [dead.id]));
  });

  it('regression (Neon e2e S4b): a job whose payload runId is not a uuid does not break the jobs list, detail or retry', async () => {
    const bad = await add(A, 'workflow.advance', { runId: 'not-a-uuid' }, { maxAttempts: 1 });
    await asOrg(A, (q) => q.exec(`update jobs set status='dead', attempts=1, finished_at=now(), last_error='bad payload' where id=$1`, [bad.id]));
    const list = await call(A, 'GET', '/jobs?status=problem');
    expect(list.status).toBe(200);
    const item = list.json.items.find((x: any) => x.id === bad.id);
    expect(item.run_id).toBeNull();
    expect(typeof item.retry_safe).toBe('boolean');
    expect((await call(A, 'GET', `/jobs/${bad.id}`)).status).toBe(200);
    const rt = await call(A, 'POST', `/jobs/${bad.id}/retry`);
    expect([200, 409]).toContain(rt.status);
    await asOrg(A, (q) => q.exec(`update jobs set status='cancelled', finished_at=now() where id=$1`, [bad.id]));
  });

  it('isolates tenants: B cannot see or touch A jobs and outbox events', async () => {
    const { id } = await add(A, 'test.always', {}, { maxAttempts: 1 });
    await drainAll();
    expect((await call(B, 'GET', `/jobs/${id}`)).status).toBe(404);
    expect((await call(B, 'POST', `/jobs/${id}/retry`)).status).toBe(404);
    expect((await call(B, 'GET', '/jobs')).json.items.map((x: any) => x.id)).not.toContain(id);
    const seenByB = await asOrg(B, (q) => q.one('select count(*)::int n from jobs where org_id=$1', [A.org]));
    expect(seenByB.n).toBe(0);
    const obB = await asOrg(B, (q) => q.one('select count(*)::int n from outbox_events where org_id=$1', [A.org]));
    expect(obB.n).toBe(0);
    await expect(asOrg(B, (q) => J.enqueue(q, { orgId: A.org!, kind: 'test.ok', createdBy: 'evil' }))).rejects.toThrow();
  });

  it('outbox → event job → workflow run; a rejected approval cannot be bypassed by retrying jobs', async () => {
    const def = {
      trigger: { type: 'event', event: 'task.created' },
      steps: [
        { type: 'approval', title: 'Make the follow-up?' },
        { type: 'action', tool: 'tasks.create', args: { title: 'RT follow-up for {{trigger.title}}' } },
      ],
    };
    const wf = await call(A, 'POST', '/workflows', { name: 'RT gate', definition: def });
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/publish`, {})).status).toBe(200);
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/enable`, {})).status).toBe(200);

    const t1 = await call(A, 'POST', '/tasks', { title: 'Alpha' });
    expect(t1.status).toBe(201);
    const ev = await asOrg(A, (q) => q.one(`select id from outbox_events where type='task.created' and event_key=$1`, [`task:${t1.json.id}`]));
    expect(ev).toBeTruthy();
    await outbox.relayOutbox();
    await outbox.relayOutbox(); // relay is idempotent
    const evJobs = await asOrg(A, (q) => q.many(`select id from jobs where idempotency_key=$1`, [`event:${ev.id}`]));
    expect(evJobs.length).toBe(1);
    await drainAll();
    const run1 = await asOrg(A, (q) => q.one(`select * from workflow_runs where workflow_id=$1 and dedupe_key=$2`, [wf.json.id, `task:${t1.json.id}`]));
    expect(run1.status).toBe('waiting_approval');
    const ap1 = await asOrg(A, (q) => q.one(`select id from approval_requests where preview->>'runId'=$1`, [run1.id]));

    expect((await call(A, 'POST', `/approvals/${ap1.id}/decision`, { decision: 'reject' })).status).toBe(200);
    expect((await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run1.id]))).status).toBe('rejected');
    const resume = await asOrg(A, (q) => q.many(`select id from jobs where idempotency_key like $1`, [`run:${run1.id}:approval:%`]));
    expect(resume.length).toBe(0);
    // Forge a "retry": the handler re-reads state and does nothing.
    await asOrg(A, (q) => wfm.enqueueAdvance(q, { orgId: A.org!, workspaceId: wf.json.workspace_id, userId: A.userId! }, run1.id, 'forged'));
    await drainAll();
    expect((await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run1.id]))).status).toBe('rejected');
    const made1 = await asOrg(A, (q) => q.one(`select count(*)::int n from tasks where title='RT follow-up for Alpha'`));
    expect(made1.n).toBe(0);

    // Approved path: runs exactly once, even on a double tap.
    const t2 = await call(A, 'POST', '/tasks', { title: 'Beta' });
    await outbox.relayOutbox();
    await drainAll();
    const run2 = await asOrg(A, (q) => q.one(`select * from workflow_runs where workflow_id=$1 and dedupe_key=$2`, [wf.json.id, `task:${t2.json.id}`]));
    const ap2 = await asOrg(A, (q) => q.one(`select id from approval_requests where preview->>'runId'=$1`, [run2.id]));
    const [d1, d2] = await Promise.all([
      call(A, 'POST', `/approvals/${ap2.id}/decision`, { decision: 'approve' }),
      call(A, 'POST', `/approvals/${ap2.id}/decision`, { decision: 'approve' }),
    ]);
    expect([d1.status, d2.status].sort()).toEqual([200, 409]);
    await drainAll();
    expect((await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run2.id]))).status).toBe('completed');
    const made2 = await asOrg(A, (q) => q.one(`select count(*)::int n from tasks where title='RT follow-up for Beta'`));
    expect(made2.n).toBe(1);
    await asOrg(A, (q) => q.exec(`update workflows set status='disabled' where id=$1`, [wf.json.id]));
  });

  it('an interrupted external step goes to needs_attention and is never resent', async () => {
    const wf = await call(A, 'POST', '/workflows', { name: 'Slack ping', definition: { trigger: { type: 'manual' }, steps: [{ type: 'slack', text: 'hello' }] } });
    const run = await asOrg(A, (q) =>
      q.one(`insert into workflow_runs (org_id, workflow_id, version, trigger_kind, context, initiated_by, status, dry_run) values ($1,$2,0,'manual','{}',$3,'running',false) returning id`, [
        A.org,
        wf.json.id,
        A.userId,
      ]),
    );
    // A version published before the Slack approval rule (publish now refuses Slack without an approval step).
    await asOrg(A, (q) =>
      q.exec(`insert into workflow_versions (org_id, workflow_id, version, definition, created_by) values ($1,$2,1,$3,$4)`, [A.org, wf.json.id, JSON.stringify({ trigger: { type: 'manual' }, steps: [{ type: 'slack', text: 'hello' }] }), A.userId]),
    );
    await asOrg(A, (q) => q.exec('update workflow_runs set version=1 where id=$1', [run.id]));
    await asOrg(A, (q) =>
      q.exec(`insert into tool_calls (org_id, workflow_run_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,'slack.post','{}','L3','allow',$3,'executing')`, [A.org, run.id, `wf:${run.id}:0`]),
    );
    await asOrg(A, (q) => wfm.enqueueAdvance(q, { orgId: A.org!, workspaceId: wf.json.workspace_id, userId: A.userId! }, run.id, 'start'));
    await drainAll();
    const r = await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run.id]));
    expect(r.status).toBe('needs_attention');
    const calls = await asOrg(A, (q) => q.many('select status from tool_calls where workflow_run_id=$1', [run.id]));
    expect(calls.map((c: any) => c.status)).toEqual(['unknown']);
  });

  // M5: supervised operations API. Every control the mobile Ops UI shows maps to one of these permission-checked calls.
  it('M5: run history views, run detail (approvals, actions, jobs, attention) and role/tenant checks', async () => {
    const wf = await call(A, 'POST', '/workflows', { name: 'Ops history', definition: { trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'Go?' }, { type: 'notify', title: 'done' }] } });
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/publish`)).status).toBe(200);
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/enable`)).status).toBe(200);
    const started = await call(A, 'POST', `/workflows/${wf.json.id}/run`, { data: {} });
    expect(started.status).toBe(201);
    await drainAll();
    const runId = started.json.id;
    const needs = await call(A, 'GET', '/workflow-runs?view=needs_you');
    expect(needs.status).toBe(200);
    const row = needs.json.items.find((x: any) => x.id === runId);
    expect(row.status).toBe('waiting_approval');
    expect(row.workflow_name).toBe('Ops history');
    expect(row.pending_approval_id).toBeTruthy();
    expect(needs.json.counts.needs_you).toBeGreaterThanOrEqual(1);
    expect((await call(A, 'GET', '/workflow-runs?view=done')).json.items.map((x: any) => x.id)).not.toContain(runId);
    expect((await call(A, 'GET', `/workflow-runs?view=all&workflowId=${wf.json.id}`)).json.items.map((x: any) => x.id)).toEqual([runId]);
    expect((await call(A, 'GET', '/workflow-runs?view=bogus')).status).toBe(400);

    const det = await call(A, 'GET', `/workflow-runs/${runId}`);
    expect(det.json.workflow.name).toBe('Ops history');
    expect(det.json.approvals.map((a: any) => a.status)).toEqual(['pending']);
    expect(det.json.permissions).toEqual({ canCancel: true, canResolve: false });
    expect(det.json.jobs.length).toBeGreaterThanOrEqual(1);
    expect(det.json.attention).toBeNull();

    // Tenant isolation: B sees none of it.
    expect((await call(B, 'GET', `/workflow-runs/${runId}`)).status).toBe(404);
    expect((await call(B, 'GET', '/workflow-runs?view=all')).json.items.map((x: any) => x.id)).not.toContain(runId);
    expect((await call(B, 'POST', `/workflow-runs/${runId}/cancel`)).status).toBe(404);
    expect((await call(B, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'retry' })).status).toBe(404);

    // A viewer may read history but sees no job internals and gets 403 on every control.
    const inv = await call(A, 'POST', '/invitations', { role: 'viewer' });
    const V: Who = await signUp('Vic');
    expect((await call(V, 'POST', '/invitations/accept', { code: inv.json.code })).status).toBe(200);
    V.org = A.org;
    const vd = await call(V, 'GET', `/workflow-runs/${runId}`);
    expect(vd.status).toBe(200);
    expect(vd.json.jobs).toEqual([]);
    expect(vd.json.permissions).toEqual({ canCancel: false, canResolve: false });
    expect((await call(V, 'POST', `/workflow-runs/${runId}/cancel`)).status).toBe(403);
    expect((await call(V, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'retry' })).status).toBe(403);
    expect((await call(V, 'GET', '/jobs?status=problem')).status).toBe(403);
    expect((await call(V, 'POST', `/jobs/${det.json.jobs[0].id}/retry`)).status).toBe(403);

    expect((await call(A, 'POST', `/workflow-runs/${runId}/cancel`)).status).toBe(200);
    expect((await call(A, 'GET', `/workflow-runs/${runId}`)).json.permissions.canCancel).toBe(false);
  });

  /** A run parked at an external Slack step whose outcome is unknown (interrupted mid-send). */
  async function stuckSlackRun(name: string) {
    const def = { trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'Post?' }, { type: 'slack', text: 'hello' }, { type: 'notify', title: 'after' }] };
    const wf = await call(A, 'POST', '/workflows', { name, definition: def });
    await asOrg(A, (q) => q.exec(`insert into workflow_versions (org_id, workflow_id, version, definition, created_by) values ($1,$2,1,$3,$4)`, [A.org, wf.json.id, JSON.stringify(def), A.userId]));
    const run = await asOrg(A, (q) =>
      q.one(`insert into workflow_runs (org_id, workflow_id, version, trigger_kind, context, initiated_by, status, current_step) values ($1,$2,1,'manual','{"approved":true}',$3,'running',1) returning id`, [A.org, wf.json.id, A.userId]),
    );
    await asOrg(A, (q) =>
      q.exec(`insert into tool_calls (org_id, workflow_run_id, tool, args, risk, policy_decision, idempotency_key, status) values ($1,$2,'slack.post','{}','L3','require_approval',$3,'executing')`, [A.org, run.id, `wf:${run.id}:1`]),
    );
    await asOrg(A, (q) => wfm.enqueueAdvance(q, { orgId: A.org!, workspaceId: wf.json.workspace_id, userId: A.userId! }, run.id, 'start'));
    await drainAll();
    expect((await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run.id]))).status).toBe('needs_attention');
    return { runId: run.id as string, workflowId: wf.json.id as string };
  }

  it('M5: an unknown-outcome step needs a person: "retry" is refused; "it happened" moves on without resending', async () => {
    const { runId } = await stuckSlackRun('Unknown happened');
    const det = await call(A, 'GET', `/workflow-runs/${runId}`);
    expect(det.json.attention).toMatchObject({ kind: 'unknown_outcome', step: 1, tool: 'slack.post' });
    expect(det.json.permissions.canResolve).toBe(true);
    expect((await call(A, 'GET', '/workflow-runs?view=needs_you')).json.items.find((x: any) => x.id === runId).outcome_unknown).toBe(true);
    // A job retry is not a way around the check either.
    const advJob = det.json.jobs.find((j: any) => j.kind === 'workflow.advance');
    await asOrg(A, (q) => q.exec(`update jobs set status='dead', finished_at=now() where id=$1`, [advJob.id]));
    const listed = (await call(A, 'GET', '/jobs?status=problem')).json.items.find((j: any) => j.id === advJob.id);
    expect(listed.retry_safe).toBe(false);
    expect(listed.run_id).toBe(runId);
    const rj = await call(A, 'POST', `/jobs/${advJob.id}/retry`);
    expect(rj.status).toBe(409);
    expect(rj.json.code).toBe('RETRY_UNSAFE');
    const rr = await call(A, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'retry' });
    expect(rr.status).toBe(409);
    expect(rr.json.code).toBe('OUTCOME_UNKNOWN');
    expect((await call(A, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'maybe' })).status).toBe(400);

    const ok = await call(A, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'happened' });
    expect(ok.status).toBe(200);
    await drainAll();
    const r = await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [runId]));
    expect(r.status).toBe('completed');
    const calls = await asOrg(A, (q) => q.many(`select status, result_summary from tool_calls where workflow_run_id=$1 and tool='slack.post'`, [runId]));
    expect(calls).toEqual([{ status: 'succeeded', result_summary: 'Confirmed by a person: it happened' }]);
    const aud = await asOrg(A, (q) => q.one(`select detail from audit_events where action='workflow.run.resolved' and target_ref=$1`, [`workflow_run:${runId}`]));
    expect(aud.detail.outcome).toBe('happened');
    // A second resolve is refused (the run is no longer stuck).
    expect((await call(A, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'happened' })).status).toBe(409);
  });

  it('M5: "it did not happen" voids the old intent and re-runs the step through the normal gate', async () => {
    const { runId } = await stuckSlackRun('Unknown not happened');
    const res = await call(A, 'POST', `/workflow-runs/${runId}/resolve`, { outcome: 'not_happened' });
    expect(res.status).toBe(200);
    await drainAll();
    const calls = await asOrg(A, (q) => q.many(`select status, idempotency_key from tool_calls where workflow_run_id=$1 and tool='slack.post' order by created_at`, [runId]));
    expect(calls.length).toBe(2);
    expect(calls[0].status).toBe('failed');
    expect(calls[0].idempotency_key).toMatch(new RegExp(`^wf:${runId}:1:void:`));
    expect(calls[1].idempotency_key).toBe(`wf:${runId}:1`);
    expect(calls[0].status).toBe('failed');
    // The step really ran again (a new intent). No Slack connection in tests, so it is recorded as skipped.
    const second = await asOrg(A, (q) => q.one(`select status, result_summary from tool_calls where idempotency_key=$1`, [`wf:${runId}:1`]));
    expect(second).toEqual({ status: 'succeeded', result_summary: 'Skipped: Slack is not connected or no channel is picked' });
    const r = await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [runId]));
    expect(r.status).toBe('completed');
  });

  it('M5: a stopped run (retries exhausted) resumes via resolve "retry" or a job retry, and never skips its approval', async () => {
    const wf = await call(A, 'POST', '/workflows', { name: 'Stopped', definition: { trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'Go?' }, { type: 'notify', title: 'done' }] } });
    await asOrg(A, (q) =>
      q.exec(`insert into workflow_versions (org_id, workflow_id, version, definition, created_by) values ($1,$2,1,$3,$4)`, [A.org, wf.json.id, JSON.stringify({ trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'Go?' }, { type: 'notify', title: 'done' }] }), A.userId]),
    );
    const mk = async () => {
      const run = await asOrg(A, (q) => q.one(`insert into workflow_runs (org_id, workflow_id, version, trigger_kind, context, initiated_by, status) values ($1,$2,1,'manual','{}',$3,'running') returning id`, [A.org, wf.json.id, A.userId]));
      const { id } = await add(A, 'workflow.advance', { runId: run.id, workspaceId: wf.json.workspace_id, userId: A.userId }, { maxAttempts: 1 });
      await J.claimById(id, 'doomed');
      await asOrg(A, (q) => q.exec(`update jobs set lease_until=now() - interval '1 second' where id=$1`, [id]));
      await J.claim('sweeper', 1);
      expect((await job(A, id)).status).toBe('dead');
      return { runId: run.id as string, jobId: id };
    };
    // Path 1: resolve "retry". "happened" is refused: there is nothing to confirm.
    const a = await mk();
    expect((await call(A, 'GET', `/workflow-runs/${a.runId}`)).json.attention).toEqual({ kind: 'stopped', step: 0 });
    expect((await call(A, 'POST', `/workflow-runs/${a.runId}/resolve`, { outcome: 'happened' })).json.code).toBe('NOTHING_TO_CONFIRM');
    expect((await call(A, 'POST', `/workflow-runs/${a.runId}/resolve`, { outcome: 'retry' })).status).toBe(200);
    await drainAll();
    expect((await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [a.runId]))).status).toBe('waiting_approval');
    // Path 2 (regression: a dead advance job retry used to be a silent no-op): the job retry resumes the run.
    const b = await mk();
    const listed = (await call(A, 'GET', '/jobs?status=problem')).json.items.find((j: any) => j.id === b.jobId);
    expect(listed.retry_safe).toBe(true);
    expect((await call(A, 'POST', `/jobs/${b.jobId}/retry`)).status).toBe(200);
    await drainAll();
    expect((await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [b.runId]))).status).toBe('waiting_approval');
    expect((await job(A, b.jobId)).status).toBe('succeeded');
    // Unknown job kinds are labelled unsafe and refused.
    const u = await add(A, 'no.such.kind', {}, { maxAttempts: 1 });
    await drainAll();
    const ul = (await call(A, 'GET', '/jobs?status=problem')).json.items.find((j: any) => j.id === u.id);
    expect(ul.retry_safe).toBe(false);
    expect((await call(A, 'POST', `/jobs/${u.id}/retry`)).status).toBe(409);
    expect((await call(A, 'GET', '/jobs?status=active')).status).toBe(200);
  });

  it('cancels a workflow run waiting for approval and expires its approval', async () => {
    const wf = await call(A, 'POST', '/workflows', { name: 'Cancel me', definition: { trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'Go?' }, { type: 'notify', title: 'done' }] } });
    await call(A, 'POST', `/workflows/${wf.json.id}/publish`, {});
    const run = await call(A, 'POST', `/workflows/${wf.json.id}/run`, { data: {} });
    expect(run.json.status).toBe('waiting_approval');
    const c = await call(A, 'POST', `/workflow-runs/${run.json.id}/cancel`);
    expect(c.status).toBe(200);
    const ap = await asOrg(A, (q) => q.one(`select id, status from approval_requests where preview->>'runId'=$1`, [run.json.id]));
    expect(ap.status).toBe('expired');
    expect((await call(A, 'POST', `/approvals/${ap.id}/decision`, { decision: 'approve' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(A, 'GET', `/workflow-runs/${run.json.id}`)).json.status).toBe('cancelled');
  });

  it('schedules enqueue once per workflow per day, and a double tick is harmless', async () => {
    const wf = await call(A, 'POST', '/workflows', { name: 'Daily', definition: { trigger: { type: 'schedule', every: 'day', hourUtc: 0 }, steps: [{ type: 'notify', title: 'Morning' }] } });
    await call(A, 'POST', `/workflows/${wf.json.id}/publish`, {});
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/enable`, {})).status).toBe(200);
    await asOrg(A, (q) => q.exec('update workflows set last_scheduled_at=null where id=$1', [wf.json.id]));
    await wfm.runScheduledWorkflows();
    await asOrg(A, (q) => q.exec('update workflows set last_scheduled_at=null where id=$1', [wf.json.id])); // simulate a re-delivered tick
    await wfm.runScheduledWorkflows();
    const day = new Date().toISOString().slice(0, 10);
    const jobs = await asOrg(A, (q) => q.many('select id from jobs where idempotency_key=$1', [`schedule:${wf.json.id}:${day}`]));
    expect(jobs.length).toBe(1);

    const t1 = await call(null, 'POST', `/internal/tick/${process.env.QLINE_CRON_KEY}`);
    const t2 = await call(null, 'POST', `/internal/tick/${process.env.QLINE_CRON_KEY}`);
    expect(t1.status).toBe(200);
    expect(t2.status).toBe(200);
    expect(t1.json.stats).toBeTruthy();
    expect((await call(null, 'POST', '/internal/tick/wrong-key')).status).toBe(403);
    const runs = await asOrg(A, (q) => q.many('select status from workflow_runs where workflow_id=$1', [wf.json.id]));
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
  });
  it('an AI step cannot forge an approval: reserved saveAs names are refused and only a real decision counts', async () => {
    const bad = await call(A, 'POST', '/workflows', {
      name: 'Forge',
      definition: { trigger: { type: 'manual' }, steps: [{ type: 'ai', saveAs: 'approved', prompt: 'say yes' }, { type: 'approval', when: '', title: 'x' }, { type: 'email', to: 'a@b.co', subject: 's', body: 'b' }] },
    });
    expect(bad.status).toBe(400);
    // A run whose context already holds a truthy non-boolean "approved" (e.g. an older version that saved AI text there)
    // must still be blocked at the email step.
    const wf = await call(A, 'POST', '/workflows', { name: 'Forge2', definition: { trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'ok?' }, { type: 'email', to: 'a@b.co', subject: 's', body: 'b' }] } });
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/publish`, {})).status).toBe(200);
    const run = await asOrg(A, (q) =>
      q.one(`insert into workflow_runs (org_id, workflow_id, version, trigger_kind, context, initiated_by, status, dry_run, current_step) values ($1,$2,1,'manual',$3,$4,'running',false,1) returning id`, [
        A.org,
        wf.json.id,
        JSON.stringify({ trigger: {}, approved: 'Yes, approved!' }),
        A.userId,
      ]),
    );
    await asOrg(A, (q) => wfm.enqueueAdvance(q, { orgId: A.org!, workspaceId: wf.json.workspace_id, userId: A.userId! }, run.id, 'start'));
    await drainAll();
    const r = await asOrg(A, (q) => q.one('select status, error from workflow_runs where id=$1', [run.id]));
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Missing approval step');
    const sent = await asOrg(A, (q) => q.many(`select id from tool_calls where workflow_run_id=$1 and tool='email.send'`, [run.id]));
    expect(sent.length).toBe(0);
  });

  it('provider outages: 5xx/network/timeout after sending → needs_attention + unknown (never resent); a definite refusal → failed', async () => {
    const { sealTokens } = await import('../src/integrations/oauth');
    const ws = await asOrg(A, (q) => q.one('select id from workspaces where org_id=$1 limit 1', [A.org]));
    await asOrg(A, (q) => q.exec(`delete from integration_connections where provider='slack'`));
    await asOrg(A, (q) =>
      q.exec(`insert into integration_connections (org_id, workspace_id, provider, status, connected_by, token_ciphertext, settings) values ($1,$2,'slack','ok',$3,$4,$5)`, [
        A.org,
        ws.id,
        A.userId,
        sealTokens(A.org!, 'slack', { access_token: 'xoxb-test' } as any),
        JSON.stringify({ channel: { id: 'C1', name: 'general' } }),
      ]),
    );
    const realFetch = globalThis.fetch;
    let mode: 'down' | 'network' | 'refused' | 'ok' = 'down';
    let posts = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith('https://slack.com/')) return realFetch(input, init);
      posts++;
      if (mode === 'network') throw new TypeError('fetch failed');
      if (mode === 'down') return new Response('upstream unavailable', { status: 503 });
      if (mode === 'refused') return new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const wf = await call(A, 'POST', '/workflows', { name: 'Slack outage', definition: { trigger: { type: 'manual' }, steps: [{ type: 'approval', title: 'Post?' }, { type: 'slack', text: 'status update' }] } });
      expect((await call(A, 'POST', `/workflows/${wf.json.id}/publish`, {})).status).toBe(200);
      const runOnce = async () => {
        const run = await call(A, 'POST', `/workflows/${wf.json.id}/run`, { data: {} });
        expect(run.json.status).toBe('waiting_approval');
        const ap = await asOrg(A, (q) => q.one(`select id from approval_requests where preview->>'runId'=$1`, [run.json.id]));
        expect((await call(A, 'POST', `/approvals/${ap.id}/decision`, { decision: 'approve' })).status).toBe(200);
        await drainAll();
        const r = await asOrg(A, (q) => q.one('select status from workflow_runs where id=$1', [run.json.id]));
        const tc = await asOrg(A, (q) => q.many(`select status from tool_calls where workflow_run_id=$1 and tool='slack.post'`, [run.json.id]));
        return { runId: run.json.id, status: r.status, calls: tc.map((x: any) => x.status) };
      };
      for (const m of ['down', 'network'] as const) {
        mode = m;
        const before = posts;
        const r = await runOnce();
        expect(r.status).toBe('needs_attention');
        expect(r.calls).toEqual(['unknown']);
        // Replaying the run's advance job must not post again.
        await asOrg(A, (q) => wfm.enqueueAdvance(q, { orgId: A.org!, workspaceId: wf.json.workspace_id, userId: A.userId! }, r.runId, 'replay'));
        await drainAll();
        expect(posts - before).toBe(1);
      }
      mode = 'refused';
      const refused = await runOnce();
      expect(refused.status).toBe('failed');
      expect(refused.calls).toEqual(['failed']);
      mode = 'ok';
      const ok = await runOnce();
      expect(ok.status).toBe('completed');
      expect(ok.calls).toEqual(['succeeded']);
    } finally {
      globalThis.fetch = realFetch;
      await asOrg(A, (q) => q.exec(`delete from integration_connections where provider='slack'`));
    }
  });
  it('Slack policy: workflow Slack posts need a human approval on every path (publish, legacy versions, replay, delegation)', async () => {
    const { sealTokens } = await import('../src/integrations/oauth');
    const { RECIPES } = await import('../src/integrations/steps');
    const { getTool } = await import('../src/agent/tools');
    const ws = await asOrg(A, (q) => q.one('select id from workspaces where org_id=$1 limit 1', [A.org]));
    await asOrg(A, (q) => q.exec(`delete from integration_connections where provider='slack'`));
    await asOrg(A, (q) =>
      q.exec(`insert into integration_connections (org_id, workspace_id, provider, status, connected_by, token_ciphertext, settings) values ($1,$2,'slack','ok',$3,$4,$5)`, [
        A.org,
        ws.id,
        A.userId,
        sealTokens(A.org!, 'slack', { access_token: 'xoxb-test' } as any),
        JSON.stringify({ channel: { id: 'C1', name: 'general' } }),
      ]),
    );
    const realFetch = globalThis.fetch;
    const posted: string[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith('https://slack.com/')) return realFetch(input, init);
      posted.push(JSON.parse(init.body).text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const status = (id: string) => asOrg(A, (q) => q.one('select status, current_step from workflow_runs where id=$1', [id]));
    const replay = (wfId: string, runId: string, why: string) => asOrg(A, (q) => wfm.enqueueAdvance(q, { orgId: A.org!, workspaceId: ws.id, userId: A.userId! }, runId, why));
    const legacy = async (name: string, steps: unknown[]) => {
      const wf = await call(A, 'POST', '/workflows', { name, definition: { trigger: { type: 'manual' }, steps: [{ type: 'notify', title: 'placeholder' }] } });
      await asOrg(A, (q) => q.exec(`insert into workflow_versions (org_id, workflow_id, version, definition, created_by) values ($1,$2,1,$3,$4)`, [A.org, wf.json.id, JSON.stringify({ trigger: { type: 'manual' }, steps }), A.userId]));
      await asOrg(A, (q) => q.exec('update workflows set published_version=1 where id=$1', [wf.json.id]));
      return wf.json.id as string;
    };
    try {
      // 1. Publish refuses Slack without an approval step before it (same rule as email), and slack.post as an action.
      const noGate = await call(A, 'POST', '/workflows', { name: 'Free post', definition: { trigger: { type: 'manual' }, steps: [{ type: 'slack', text: 'hi' }] } });
      const pub = await call(A, 'POST', `/workflows/${noGate.json.id}/publish`, {});
      expect(pub.status).toBe(400);
      expect(JSON.stringify(pub.json)).toMatch(/Slack needs an approval step/);
      const asAction = await call(A, 'POST', '/workflows', { name: 'Free post 2', definition: { trigger: { type: 'manual' }, steps: [{ type: 'action', tool: 'slack.post', args: { text: 'hi' } }] } });
      if (asAction.status === 201) expect((await call(A, 'POST', `/workflows/${asAction.json.id}/publish`, {})).status).toBe(400);
      // Built-in recipes still publish (they now ask before posting).
      for (const r of RECIPES) {
        const w = await call(A, 'POST', '/workflows', { name: `Recipe ${r.id}`, definition: r.definition });
        expect(w.status).toBe(201);
        expect((await call(A, 'POST', `/workflows/${w.json.id}/publish`, {})).status).toBe(200);
      }

      // 2. A version published before the rule: the run parks on a per-post approval instead of posting.
      const old1 = await legacy('Legacy briefing', [{ type: 'notify', title: 'n' }, { type: 'slack', text: 'legacy post A' }]);
      const r1 = await call(A, 'POST', `/workflows/${old1}/run`, { data: {} });
      expect(r1.json.status).toBe('waiting_approval');
      expect(posted).toEqual([]);
      const ap1 = await asOrg(A, (q) => q.one(`select id, preview from approval_requests where preview->>'runId'=$1`, [r1.json.id]));
      expect(ap1.preview.lines[0]).toContain('legacy post A');
      // Replays and forged jobs while waiting do not post.
      await replay(old1, r1.json.id, 'forged-1');
      await drainAll();
      expect(posted).toEqual([]);
      // Rejected: never posts, even if replayed afterwards.
      expect((await call(A, 'POST', `/approvals/${ap1.id}/decision`, { decision: 'reject' })).status).toBe(200);
      await replay(old1, r1.json.id, 'forged-2');
      await drainAll();
      expect((await status(r1.json.id)).status).toBe('rejected');
      expect(posted).toEqual([]);
      const tc1 = await asOrg(A, (q) => q.many(`select status from tool_calls where workflow_run_id=$1 and tool='slack.post'`, [r1.json.id]));
      expect(tc1.length).toBe(0);

      // 3. Approved (double tap): exactly one decision wins, the post happens exactly once, replays do not repost.
      const r2 = await call(A, 'POST', `/workflows/${old1}/run`, { data: {} });
      const ap2 = await asOrg(A, (q) => q.one(`select id from approval_requests where preview->>'runId'=$1`, [r2.json.id]));
      const [d1, d2] = await Promise.all([call(A, 'POST', `/approvals/${ap2.id}/decision`, { decision: 'approve' }), call(A, 'POST', `/approvals/${ap2.id}/decision`, { decision: 'approve' })]);
      expect([d1.status, d2.status].sort()).toEqual([200, 409]);
      await drainAll();
      expect((await status(r2.json.id)).status).toBe('completed');
      await replay(old1, r2.json.id, 'forged-3');
      await drainAll();
      expect(posted).toEqual(['legacy post A']);
      const tc2 = await asOrg(A, (q) => q.many(`select status, policy_decision from tool_calls where workflow_run_id=$1 and tool='slack.post'`, [r2.json.id]));
      expect(tc2).toEqual([{ status: 'succeeded', policy_decision: 'require_approval' }]);

      // 4. A per-post approval covers only that post: the next Slack step asks again.
      posted.length = 0;
      const old2 = await legacy('Legacy two posts', [{ type: 'slack', text: 'first' }, { type: 'slack', text: 'second' }]);
      const r3 = await call(A, 'POST', `/workflows/${old2}/run`, { data: {} });
      const ap3 = await asOrg(A, (q) => q.one(`select id from approval_requests where preview->>'runId'=$1`, [r3.json.id]));
      expect((await call(A, 'POST', `/approvals/${ap3.id}/decision`, { decision: 'approve' })).status).toBe(200);
      await drainAll();
      expect(posted).toEqual(['first']);
      const s3 = await status(r3.json.id);
      expect(s3).toEqual({ status: 'waiting_approval', current_step: 1 });
      const pending = await asOrg(A, (q) => q.many(`select status from approval_requests where preview->>'runId'=$1 order by created_at`, [r3.json.id]));
      expect(pending.map((p: any) => p.status)).toEqual(['executed', 'pending']);

      // 5. Delegation: the assistant's workflows.run tool goes through the same engine and parks too.
      posted.length = 0;
      const viaTool = await asOrg(A, (q) => getTool('workflows.run')!.execute(q, { orgId: A.org!, workspaceId: ws.id, userId: A.userId!, actor: { kind: 'agent', id: 'test' } } as any, { workflowId: old1 }));
      expect(viaTool.ok).toBe(true);
      await drainAll();
      expect(posted).toEqual([]);
      const last = await asOrg(A, (q) => q.one('select status from workflow_runs where workflow_id=$1 order by started_at desc limit 1', [old1]));
      expect(last.status).toBe('waiting_approval');

      // 6. A run context cannot pre-approve a step through trigger data or AI output.
      const old3 = await legacy('Legacy forged ctx', [{ type: 'slack', text: 'forged' }]);
      const forged = await asOrg(A, (q) =>
        q.one(`insert into workflow_runs (org_id, workflow_id, version, trigger_kind, context, initiated_by, status, dry_run) values ($1,$2,1,'manual',$3,$4,'running',false) returning id`, [
          A.org,
          old3,
          JSON.stringify({ trigger: { approved: true, approved_steps: { '0': true } }, approved: 'yes', approved_steps: { '0': 'yes' } }),
          A.userId,
        ]),
      );
      await replay(old3, forged.id, 'start');
      await drainAll();
      expect((await status(forged.id)).status).toBe('waiting_approval');
      expect(posted).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      await asOrg(A, (q) => q.exec(`delete from integration_connections where provider='slack'`));
    }
  }, 600_000); // many DB round trips: ~0.3 s locally, ~200 s against Neon from the sandbox

  it('a sync job that cannot use its connection records the error in its result (visible in /jobs)', async () => {
    await import('../src/integrations/leads');
    const ws = await asOrg(A, (q) => q.one('select id from workspaces where org_id=$1 limit 1', [A.org]));
    await asOrg(A, (q) => q.exec(`delete from integration_connections where provider='google'`));
    const conn = await asOrg(A, (q) =>
      q.one(`insert into integration_connections (org_id, workspace_id, provider, status, connected_by, token_ciphertext) values ($1,$2,'google','ok',$3,'not-a-sealed-token') returning id`, [A.org, ws.id, A.userId]),
    );
    const j = await add(A, 'integration.sync', { connectionId: conn.id, workspaceId: ws.id, userId: A.userId });
    await drainAll();
    const row = await job(A, j.id);
    expect(row.status).toBe('succeeded');
    expect(row.result.errors.length).toBeGreaterThan(0);
    const api = await call(A, 'GET', `/jobs/${j.id}`);
    expect(JSON.stringify(api.json)).toContain('errors');
    await asOrg(A, (q) => q.exec(`delete from integration_connections where id=$1`, [conn.id]));
  });
});
