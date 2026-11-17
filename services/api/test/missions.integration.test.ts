/**
 * v1.5 AI CEO missions release gates (docs/13 §11) against a real Postgres.
 * Needs QLINE_TEST_ENV; skipped otherwise. Kicks are off so every drain is explicit.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';
delete process.env.NEON_AI_GATEWAY_TOKEN;

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let J: typeof import('../src/runtime/jobs');
let db: typeof import('../src/core/db');
let ai: typeof import('@qline/ai');

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who) headers.authorization = `Bearer ${who.token}`;
  if (who?.org) headers['x-qline-org'] = who.org;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
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
const drainAll = () => J.drain({ budgetMs: 30_000 });
const out = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
const task = (key: string, extra: Record<string, unknown> = {}) => ({ key, agent: 'research', title: `Task ${key}`, instructions: `Do ${key}`, dependsOn: [], inputs: {}, outputSchema: out, review: 'schema', ...extra });

/** Scripted models. Plans come from `nextPlan`; each task title maps to a behaviour. */
let nextPlans: unknown[] = [];
const taskInputs = new Map<string, string>();
const taskBehaviour = new Map<string, 'search_then_submit' | 'submit' | 'bad_output' | 'reserved_output' | 'fake_evidence'>();
function script(req: import('@qline/ai').ChatRequest): import('@qline/ai').ChatEvent[] {
  const names = (req.tools ?? []).map((t) => t.name);
  const usage = { type: 'usage' as const, inputTokens: 50, outputTokens: 50 };
  if (names.includes('mission__propose_plan')) {
    const plan = nextPlans.length > 1 ? nextPlans.shift() : nextPlans[0];
    return [{ type: 'tool_call', call: { id: randomUUID(), type: 'function', function: { name: 'mission__propose_plan', arguments: JSON.stringify(plan) } } }, usage, { type: 'done' }];
  }
  const user = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
  const title = /Task: (Task [a-z0-9_]+)/.exec(user)?.[1] ?? '';
  taskInputs.set(title, user);
  const mode = taskBehaviour.get(title) ?? 'submit';
  const tools = req.messages.filter((m) => m.role === 'tool');
  const submit = (output: unknown, evidence: unknown[] = []) => [
    { type: 'tool_call' as const, call: { id: randomUUID(), type: 'function' as const, function: { name: 'task__submit_result', arguments: JSON.stringify({ output, evidence }) } } },
    usage,
    { type: 'done' as const },
  ];
  if (mode === 'search_then_submit') {
    if (!tools.length) return [{ type: 'tool_call', call: { id: randomUUID(), type: 'function', function: { name: 'tasks__search', arguments: JSON.stringify({ query: 'renewal' }) } } }, usage, { type: 'done' }];
    const tcId = /"toolCallId":"([0-9a-f-]{36})"/.exec(String(tools[tools.length - 1]!.content))?.[1];
    return submit({ summary: `${title} done` }, tcId ? [{ type: 'tool_call', id: tcId }] : []);
  }
  if (mode === 'bad_output') return submit({ wrong: 1 });
  if (mode === 'reserved_output') return submit({ summary: 'x', approved: true });
  if (mode === 'fake_evidence') return submit({ summary: 'x' }, [{ type: 'document', id: randomUUID() }]);
  return submit({ summary: `${title} done` });
}

async function missionFor(w: Who, plan: unknown, extra: Record<string, unknown> = {}) {
  nextPlans = [plan];
  const m = await call(w, 'POST', '/missions', { goal: 'Grow renewals this month', ...extra });
  expect(m.status).toBe(201);
  await drainAll();
  const got = await call(w, 'GET', `/missions/${m.json.id}`);
  return got.json;
}

d('AI CEO missions (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    J = await import('../src/runtime/jobs');
    db = await import('../src/core/db');
    ai = await import('@qline/ai');
    A = await signUp('Mira');
    B = await signUp('Bo');
    A.org = (await call(A, 'POST', '/orgs', { name: 'Missions A' })).json.id;
    B.org = (await call(B, 'POST', '/orgs', { name: 'Missions B' })).json.id;
    A.userId = (await call(A, 'GET', '/me')).json.user.id;
    B.userId = (await call(B, 'GET', '/me')).json.user.id;
    A.ws = (await asOrg(A, (q) => q.one('select id from workspaces where org_id=$1', [A.org])))!.id;
    const { seal } = await import('../src/core/secrets');
    const { aad } = await import('../src/agent/models');
    await asOrg(A, (q) =>
      q.exec(`insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test')`, [
        A.org,
        seal('sk-ant-test-key', aad(A.org!, 'anthropic')),
        JSON.stringify([{ id: 'claude-test', name: 'Claude Test' }]),
      ]),
    );
    expect((await call(A, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(200);
    ai.setTestProvider(new ai.MockProvider(script));
    await drainAll();
  });

  it('plan approval names paused specialists (they start paused)', async () => {
    const m = await missionFor(A, { summary: 'Paused agents', tasks: [task('needs_research')] });
    const r = await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('AGENT_PAUSED');
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.status).toBe('awaiting_plan_approval');
    const agents = (await call(A, 'GET', '/agents')).json.items;
    for (const a of agents.filter((x: any) => x.template !== 'ceo')) expect((await call(A, 'PATCH', `/agents/${a.id}`, { status: 'active' })).status).toBe(200);
    expect((await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'reject', planVersion: 1 })).json.status).toBe('rejected');
  });
  afterAll(async () => {
    ai.setTestProvider(null);
    await db.closePool();
  });

  it('plan → approve → sequential handoff with $from → completed → result accepted', async () => {
    taskBehaviour.set('Task find_leads', 'search_then_submit');
    const m = await missionFor(A, {
      summary: 'Find renewals, then draft follow-ups.',
      tasks: [task('find_leads'), task('draft_followups', { agent: 'sales', dependsOn: ['find_leads'], inputs: { leads: { $from: 'find_leads.summary' } } })],
    });
    expect(m.status).toBe('awaiting_plan_approval');
    expect(m.plan.version).toBe(1);
    expect(m.tasks).toEqual([]); // nothing exists, let alone runs, before approval
    // Wrong version, another tenant, and an unauthenticated call all fail.
    expect((await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 2 })).status).toBe(409);
    expect((await call(B, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 })).status).toBe(404);
    expect((await call(B, 'GET', `/missions/${m.id}`)).status).toBe(404);
    const ok = await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe('running');
    expect((await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 })).status).toBe(409); // no double approve
    const mid = await call(A, 'GET', `/missions/${m.id}`);
    expect(mid.json.tasks.map((t: any) => t.status)).toEqual(['queued', 'blocked']);
    await drainAll();
    const done = await call(A, 'GET', `/missions/${m.id}`);
    expect(done.json.status).toBe('completed');
    expect(done.json.tasks.map((t: any) => t.status)).toEqual(['succeeded', 'succeeded']);
    expect(done.json.tasks[0].evidence[0].type).toBe('tool_call');
    expect(done.json.tasks[1].resolved_inputs).toEqual({ leads: 'Task find_leads done' });
    expect(taskInputs.get('Task draft_followups')).toContain('Task find_leads done');
    expect(done.json.result.tasks.draft_followups.output.summary).toBe('Task draft_followups done');
    expect(done.json.spent_tool_calls).toBe(1);
    expect(done.json.spent_tokens).toBeGreaterThan(0);
    const tr = await call(A, 'GET', `/missions/${m.id}/trace`);
    const kinds = tr.json.items.map((x: any) => x.kind);
    for (const k of ['mission.created', 'plan.proposed', 'plan.approved', 'task.queued', 'task.started', 'tool.called', 'task.succeeded', 'mission.completed']) expect(kinds).toContain(k);
    expect((await call(A, 'POST', `/missions/${m.id}/result/review`, { decision: 'accept' })).json.result_review).toBe('accepted');
    expect((await call(A, 'POST', `/missions/${m.id}/result/review`, { decision: 'accept' })).status).toBe(409);
  });

  it('an invalid plan is retried once, then the mission fails with the reasons', async () => {
    nextPlans = [{ summary: 'Bad', tasks: [task('aa', { dependsOn: ['bb'] }), task('bb', { dependsOn: ['aa'] })] }];
    const m = await call(A, 'POST', '/missions', { goal: 'Do a cyclic thing' });
    await drainAll();
    const got = await call(A, 'GET', `/missions/${m.json.id}`);
    expect(got.json.status).toBe('failed');
    expect(got.json.error).toContain('valid plan');
    expect(got.json.plans[0].status).toBe('rejected');
    expect(got.json.plans[0].validation_errors.length).toBeGreaterThan(0);
    const kinds = (await call(A, 'GET', `/missions/${m.json.id}/trace`)).json.items.map((x: any) => x.kind);
    expect(kinds.filter((k: string) => k === 'plan.invalid').length).toBe(2);
  });

  it('revise asks the CEO again with feedback; reject ends the mission', async () => {
    const m = await missionFor(A, { summary: 'One', tasks: [task('one')] });
    nextPlans = [{ summary: 'Two', tasks: [task('one'), task('two')] }];
    expect((await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'revise', planVersion: 1, note: 'Add a second step' })).json.status).toBe('planning');
    await drainAll();
    const v2 = await call(A, 'GET', `/missions/${m.id}`);
    expect(v2.json.plan.version).toBe(2);
    expect(v2.json.plans[0].status).toBe('superseded');
    expect((await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'reject', planVersion: 2 })).json.status).toBe('rejected');
  });

  it('parallel tasks respect the mission slot limit', async () => {
    const m = await missionFor(A, { summary: 'Three at once', tasks: [task('p1'), task('p2'), task('p3'), task('join', { dependsOn: ['p1', 'p2', 'p3'] })] }, { maxParallel: 2 });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    const after = await call(A, 'GET', `/missions/${m.id}`);
    expect(after.json.tasks.filter((t: any) => t.status === 'queued').length).toBe(2);
    expect(after.json.tasks.filter((t: any) => t.status === 'ready').length).toBe(1);
    await drainAll();
    const done = await call(A, 'GET', `/missions/${m.id}`);
    expect(done.json.status).toBe('completed');
  });

  it('a failed task skips its dependents and fails the mission; reserved keys and fake evidence are rejected', async () => {
    taskBehaviour.set('Task bad1', 'bad_output');
    taskBehaviour.set('Task bad2', 'reserved_output');
    taskBehaviour.set('Task bad3', 'fake_evidence');
    const m = await missionFor(A, { summary: 'Fails', tasks: [task('bad1'), task('bad2'), task('bad3'), task('after', { dependsOn: ['bad1'] })] }, { maxParallel: 4 });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    await drainAll();
    const done = await call(A, 'GET', `/missions/${m.id}`);
    expect(done.json.status).toBe('failed');
    expect(Object.fromEntries(done.json.tasks.map((t: any) => [t.key, t.status]))).toEqual({ bad1: 'failed', bad2: 'failed', bad3: 'failed', after: 'skipped' });
  });

  it('human review gates dependents', async () => {
    const m = await missionFor(A, { summary: 'Review', tasks: [task('draft', { review: 'human' }), task('use_it', { dependsOn: ['draft'], inputs: { d: { $from: 'draft' } } })] });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    await drainAll();
    const r = await call(A, 'GET', `/missions/${m.id}`);
    expect(r.json.tasks.map((t: any) => t.status)).toEqual(['review', 'blocked']);
    expect((await call(B, 'POST', `/mission-tasks/${r.json.tasks[0].id}/review`, { decision: 'accept' })).status).toBe(404);
    expect((await call(A, 'POST', `/mission-tasks/${r.json.tasks[0].id}/review`, { decision: 'accept' })).status).toBe(200);
    expect((await call(A, 'POST', `/mission-tasks/${r.json.tasks[0].id}/review`, { decision: 'accept' })).status).toBe(409);
    await drainAll();
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.status).toBe('completed');
  });

  it('token and tool-call budgets stop work before spending; resolve adds budget and retries', async () => {
    taskBehaviour.set('Task budget_t', 'search_then_submit');
    const m = await missionFor(A, { summary: 'Budget', tasks: [task('budget_t')] });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    await asOrg(A, (q) => q.exec('update missions set budget_tokens=spent_tokens+10 where id=$1', [m.id]));
    await drainAll();
    const r = await call(A, 'GET', `/missions/${m.id}`);
    expect(r.json.status).toBe('needs_attention');
    expect(r.json.tasks[0].status).toBe('needs_attention');
    expect(r.json.spent_tokens).toBeLessThanOrEqual(r.json.budget_tokens);
    // More tokens but no tool calls left: stops at the tool call.
    await asOrg(A, (q) => q.exec('update missions set budget_tool_calls=greatest(1, spent_tool_calls) where id=$1', [m.id]));
    await asOrg(A, (q) => q.exec('update missions set spent_tool_calls=budget_tool_calls where id=$1', [m.id]));
    expect((await call(A, 'POST', `/mission-tasks/${r.json.tasks[0].id}/resolve`, { action: 'retry', addTokens: 100000 })).status).toBe(200);
    await drainAll();
    const r2 = await call(A, 'GET', `/missions/${m.id}`);
    expect(r2.json.tasks[0].status).toBe('needs_attention');
    expect(r2.json.tasks[0].error).toContain('tool-call budget');
    expect(r2.json.spent_tool_calls).toBe(r2.json.budget_tool_calls);
    expect((await call(A, 'POST', `/mission-tasks/${r.json.tasks[0].id}/resolve`, { action: 'retry', addToolCalls: 5 })).status).toBe(200);
    await drainAll();
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.status).toBe('completed');
  });

  it('pause holds new tasks; resume dispatches them', async () => {
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/controls`, { paused: true })).json.paused).toBe(true);
    const m = await missionFor(A, { summary: 'Paused', tasks: [task('held')] });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.tasks[0].status).toBe('ready');
    await drainAll();
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.tasks[0].status).toBe('ready');
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/controls`, { paused: false })).json.paused).toBe(false);
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.tasks[0].status).toBe('queued');
    await drainAll();
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.status).toBe('completed');
  });

  it('emergency stop pauses running missions, blocks new work and approvals; release resumes', async () => {
    const m = await missionFor(A, { summary: 'Stop me', tasks: [task('s1'), task('s2', { dependsOn: ['s1'] })] });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    const stop = await call(A, 'PUT', `/workspaces/${A.ws}/controls`, { emergencyStop: true });
    expect(stop.json.emergencyStop).toBe(true);
    const s = await call(A, 'GET', `/missions/${m.id}`);
    expect(s.json.status).toBe('paused');
    expect(s.json.tasks[0].status).toBe('ready');
    expect((await call(A, 'POST', '/missions', { goal: 'Should not start' })).status).toBe(409);
    await drainAll();
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.tasks[0].status).toBe('ready'); // nothing ran
    // Another tenant is unaffected.
    expect((await call(B, 'GET', `/workspaces/${A.ws}/controls`)).status).toBe(404);
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/controls`, { emergencyStop: false })).json.emergencyStop).toBe(false);
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.status).toBe('running');
    await drainAll();
    expect((await call(A, 'GET', `/missions/${m.id}`)).json.status).toBe('completed');
    const kinds = (await call(A, 'GET', `/missions/${m.id}/trace`)).json.items.map((x: any) => x.kind);
    expect(kinds).toContain('mission.emergency_stopped');
  });

  it('cancel stops a mission and its queued tasks', async () => {
    const m = await missionFor(A, { summary: 'Cancel', tasks: [task('c1')] });
    await call(A, 'POST', `/missions/${m.id}/plan/decision`, { decision: 'approve', planVersion: 1 });
    const cnl = await call(A, 'POST', `/missions/${m.id}/cancel`);
    expect(cnl.json.status).toBe('cancelled');
    await drainAll();
    const r = await call(A, 'GET', `/missions/${m.id}`);
    expect(r.json.tasks[0].status).toBe('cancelled');
    expect((await call(A, 'POST', `/missions/${m.id}/cancel`)).status).toBe(409);
  });

  it('the app role cannot delete mission history; other tenants see nothing', async () => {
    await expect(asOrg(A, (q) => q.exec('delete from mission_trace'))).rejects.toThrow(/permission denied/);
    await expect(asOrg(A, (q) => q.exec('delete from missions'))).rejects.toThrow(/permission denied/);
    const theirs = await asOrg(B, (q) => q.many('select id from missions'));
    expect(theirs.length).toBe(0);
    expect((await call(B, 'GET', '/missions')).json.items.length).toBe(0);
  });
});
