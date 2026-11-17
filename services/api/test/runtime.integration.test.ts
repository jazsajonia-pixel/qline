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
    await drainAll();
    let j = await job(A, id);
    expect(j.status).toBe('queued');
    expect(j.attempts).toBe(1);
    expect(new Date(j.run_at).getTime()).toBeGreaterThan(Date.now() + 2_000);
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

  it('isolates tenants: B cannot see or touch A jobs and outbox events', async () => {
    const { id } = await add(A, 'test.always', {}, { maxAttempts: 1 });
    await drainAll();
    expect((await call(B, 'GET', `/jobs/${id}`)).status).toBe(404);
    expect((await call(B, 'POST', `/jobs/${id}/retry`)).status).toBe(409);
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
    // Publish so the definition exists for version 1, then point the run at it.
    expect((await call(A, 'POST', `/workflows/${wf.json.id}/publish`, {})).status).toBe(200);
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
