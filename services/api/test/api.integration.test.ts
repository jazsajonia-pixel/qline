/**
 * Integration tests against a real Postgres (a Neon dev branch).
 * Needs QLINE_TEST_ENV pointing at an env file with APP_DATABASE_URL and BETTER_AUTH_SECRET.
 * Skipped when it is not set, so unit CI does not need a database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
delete process.env.NEON_AI_GATEWAY_TOKEN;

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let ai: typeof import('@qline/ai');

async function call(who: Who | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (who) headers.authorization = `Bearer ${who.token}`;
  if (who?.org) headers['x-qline-org'] = who.org;
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers, body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function signUp(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, 'POST', '/auth/sign-up/email', { email, password: 'correct-horse-battery', name });
  expect(r.status).toBe(200);
  return { token: r.json.token };
}

d('Qline API (integration)', () => {
  let A: Who;
  let B: Who;
  let M: Who; // viewer in A's org
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    ai = await import('@qline/ai');
    A = await signUp('Alice');
    B = await signUp('Bob');
    M = await signUp('Vera');
    const oa = await call(A, 'POST', '/orgs', { name: 'Acme Studio' });
    expect(oa.status).toBe(201);
    A.org = oa.json.id;
    const ob = await call(B, 'POST', '/orgs', { name: 'Beta Co' });
    B.org = ob.json.id;
  });
  afterAll(async () => {
    const { closePool } = await import('../src/core/db');
    await closePool();
  });

  it('health is public, tenant routes need auth and membership', async () => {
    expect((await call(null, 'GET', '/health')).status).toBe(200);
    expect((await call(null, 'GET', '/tasks')).status).toBe(401);
    expect((await call({ token: A.token }, 'GET', '/tasks')).status).toBe(400);
    expect((await call({ token: A.token, org: B.org }, 'GET', '/tasks')).status).toBe(404);
    const me = await call(A, 'GET', '/me');
    expect(me.json.orgs.map((o: any) => o.id)).toContain(A.org);
  });

  it('isolates tenants: B cannot list, read, update or delete A rows', async () => {
    const t = await call(A, 'POST', '/tasks', { title: 'Secret plan for Acme' });
    expect(t.status).toBe(201);
    const c = await call(A, 'POST', '/contacts', { name: 'Carla Client', email: 'carla@acme.test' });
    expect(c.status).toBe(201);
    const bt = await call(B, 'GET', '/tasks');
    expect(bt.status).toBe(200);
    expect(bt.json.items.find((x: any) => x.id === t.json.id)).toBeUndefined();
    expect((await call(B, 'GET', `/tasks/${t.json.id}`)).status).toBe(404);
    expect((await call(B, 'PATCH', `/tasks/${t.json.id}`, { title: 'pwned' })).status).toBe(404);
    expect((await call(B, 'DELETE', `/tasks/${t.json.id}`)).status).toBe(404);
    expect((await call(B, 'PATCH', `/contacts/${c.json.id}`, { name: 'x' })).status).toBe(404);
    const bs = await call(B, 'GET', '/search?q=Secret');
    expect(JSON.stringify(bs.json)).not.toContain('Secret plan');
    const ba = await call(B, 'GET', '/audit');
    expect(JSON.stringify(ba.json)).not.toContain(t.json.id);
    // Still visible to A
    expect((await call(A, 'GET', `/tasks/${t.json.id}`)).json.title).toBe('Secret plan for Acme');
  });

  it('invites a viewer with a one-time code and enforces roles', async () => {
    const inv = await call(A, 'POST', '/invitations', { role: 'viewer' });
    expect(inv.status).toBe(201);
    const acc = await call({ token: M.token }, 'POST', '/invitations/accept', { code: inv.json.code });
    expect(acc.status).toBe(200);
    M.org = A.org;
    expect((await call({ token: B.token }, 'POST', '/invitations/accept', { code: inv.json.code })).status).toBe(404);
    expect((await call(M, 'GET', '/tasks')).status).toBe(200);
    expect((await call(M, 'POST', '/tasks', { title: 'viewer cannot' })).status).toBe(403);
    expect((await call(M, 'GET', '/exports')).status).toBe(403);
  });

  it('keeps an intact audit hash chain', async () => {
    const v = await call(A, 'GET', '/audit/verify');
    expect(v.status).toBe(200);
    expect(v.json.ok).toBe(true);
    expect(v.json.checked).toBeGreaterThan(3);
  });

  it('honours Idempotency-Key', async () => {
    const key = randomUUID();
    const r1 = await call(A, 'POST', '/tasks', { title: 'Once only' }, { 'idempotency-key': key });
    const r2 = await call(A, 'POST', '/tasks', { title: 'Once only' }, { 'idempotency-key': key });
    expect(r2.json.id).toBe(r1.json.id);
    expect(r2.headers.get('idempotent-replay')).toBe('true');
  });

  it('AI providers: honest when none is connected, owner-only keys, real key validation', async () => {
    const o = await call(A, 'GET', '/ai/overview');
    expect(o.status).toBe(200);
    expect(o.json.status).toBe('not_configured');
    expect(o.json.providers.map((p: any) => p.id)).toEqual(['openai', 'anthropic', 'google', 'xai', 'deepseek']);
    expect(o.json.providers.every((p: any) => !p.connected)).toBe(true);
    const conv = await call(A, 'POST', '/conversations', {});
    const m = await call(A, 'POST', `/conversations/${conv.json.id}/messages`, { content: 'Hello' });
    expect(m.status).toBe(202);
    const st = await app.fetch(new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, { headers: { authorization: `Bearer ${A.token}`, 'x-qline-org': A.org! } }));
    const body = await st.text();
    expect(body).toContain('AI_PROVIDER_NOT_CONFIGURED');
    expect(body).toContain('Settings');
    expect((await call(A, 'GET', `/runs/${m.json.runId}`)).json.status).toBe('failed');
    // Viewers cannot add keys; unknown providers 404; a fake key is rejected by Google itself.
    expect((await call(M, 'PUT', '/ai/providers/google', { apiKey: 'AIzaFAKEFAKEFAKEFAKEFAKE' })).status).toBe(403);
    expect((await call(A, 'PUT', '/ai/providers/nope', { apiKey: 'AIzaFAKEFAKEFAKEFAKEFAKE' })).status).toBe(404);
    const bad = await call(A, 'PUT', '/ai/providers/google', { apiKey: 'AIzaSyFAKE-not-a-real-key-000000000' });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('AI_KEY_REJECTED');
    expect((await call(A, 'PUT', '/ai/default', { provider: 'google', model: 'gemini-x' })).status).toBe(409);
  });

  it('runs an agent with tools, parks risky actions for human approval, executes once', async () => {
    // Connect a provider the way the API stores it (encrypted), then assign it.
    const { seal } = await import('../src/core/secrets');
    const { aad } = await import('../src/agent/models');
    const { withTenant } = await import('../src/core/db');
    const me = await call(A, 'GET', '/me');
    const userId = me.json.user?.id ?? me.json.id;
    await withTenant({ orgId: A.org!, userId }, (q) =>
      q.exec(`insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test')`, [
        A.org,
        seal('sk-ant-test-key', aad(A.org!, 'anthropic')),
        JSON.stringify([{ id: 'claude-test', name: 'Claude Test' }]),
      ]),
    );
    const ov = await call(A, 'GET', '/ai/overview');
    expect(ov.json.status).toBe('no_default');
    expect(JSON.stringify(ov.json)).not.toContain('sk-ant-test-key');
    expect(ov.json.providers.find((p: any) => p.id === 'anthropic')).toMatchObject({ connected: true, keyHint: 'TEST', modelCount: 1 });
    expect((await call(B, 'GET', '/ai/overview')).json.providers.find((p: any) => p.id === 'anthropic').connected).toBe(false);
    expect((await call(M, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(403);
    expect((await call(A, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(200);
    const ceo = ov.json.agents.find((a: any) => a.template === 'ceo');
    expect((await call(A, 'PUT', `/agents/${ceo.id}/model`, { provider: 'openai', model: 'gpt-x' })).status).toBe(409); // not connected
    const setM = await call(A, 'PUT', `/agents/${ceo.id}/model`, { provider: 'anthropic', model: 'claude-test' });
    expect(setM.status).toBe(200);
    expect(setM.json.version).toBeGreaterThan(1);
    const ov2 = await call(A, 'GET', '/ai/overview');
    expect(ov2.json.status).toBe('ready');
    expect(ov2.json.agents.find((a: any) => a.id === ceo.id)).toMatchObject({ assignment: { provider: 'anthropic', model: 'claude-test' }, ready: true });

    let turn = 0;
    const mock = new ai.MockProvider((req) => {
        turn++;
        const lastTool = [...req.messages].reverse().find((m) => m.role === 'tool');
        if (!lastTool) {
          return [
            { type: 'tool_call', call: { id: 'c1', type: 'function', function: { name: 'tasks__search', arguments: JSON.stringify({ query: 'Secret' }) } } },
            { type: 'tool_call', call: { id: 'c2', type: 'function', function: { name: 'tasks__create', arguments: JSON.stringify({ title: 'Call Carla about renewal' }) } } },
            { type: 'done' },
          ];
        }
        return [{ type: 'token', text: 'I found 1 task and asked you to approve a new one.' }, { type: 'usage', inputTokens: 10, outputTokens: 12 }, { type: 'done' }];
      });
    ai.setTestProvider(mock);
    try {
      const conv = await call(A, 'POST', '/conversations', {});
      const m = await call(A, 'POST', `/conversations/${conv.json.id}/messages`, { content: 'What is open, and add a follow-up task' });
      const st = await app.fetch(new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, { headers: { authorization: `Bearer ${A.token}`, 'x-qline-org': A.org! } }));
      const sse = await st.text();
      expect(sse).toContain('approval.required');
      expect(sse).toContain('tool.result');
      const before = await call(A, 'GET', '/tasks?q=Call%20Carla');
      expect(before.json.items.length).toBe(0); // not executed yet
      const list = await call(A, 'GET', '/approvals?status=pending');
      const appr = list.json.items.find((x: any) => x.action === 'tasks.create');
      expect(appr).toBeTruthy();
      // Service actors and viewers cannot decide
      expect((await call(A, 'POST', `/approvals/${appr.id}/decision`, { decision: 'approve' }, { 'x-qline-service': 'workflow' })).status).toBe(403);
      expect((await call(M, 'POST', `/approvals/${appr.id}/decision`, { decision: 'approve' })).status).toBe(403);
      // B cannot even see it
      expect((await call(B, 'GET', `/approvals/${appr.id}`)).status).toBe(404);
      const ok = await call(A, 'POST', `/approvals/${appr.id}/decision`, { decision: 'approve' });
      expect(ok.status).toBe(200);
      expect((await call(A, 'POST', `/approvals/${appr.id}/decision`, { decision: 'approve' })).status).toBe(409);
      const after = await call(A, 'GET', '/tasks?q=Call%20Carla');
      expect(after.json.items.length).toBe(1);
      expect(after.json.items[0].created_by).toMatch(/^agent:/);
      expect(turn).toBeGreaterThanOrEqual(1);
      expect(mock.calls[0].model).toBe('claude-test');
      expect(sse).toContain('"provider":"anthropic"');
    } finally {
      ai.setTestProvider(null);
    }
    // Back to "use workspace default", then disconnect.
    expect((await call(A, 'PUT', `/agents/${ceo.id}/model`, { provider: null })).status).toBe(200);
    expect((await call(A, 'PUT', '/ai/default', { provider: null })).status).toBe(200);
    expect((await call(A, 'DELETE', '/ai/providers/anthropic')).status).toBe(200);
    expect((await call(A, 'GET', '/ai/overview')).json.status).toBe('not_configured');
  });

  it('onboarding: rules analysis → proposal → apply → rollback', async () => {
    const s = await call(A, 'POST', '/onboarding/sessions', {});
    expect(s.status).toBe(201);
    const ans = await call(A, 'POST', `/onboarding/sessions/${s.json.session.id}/answers`, {
      answers: {
        businessName: { value: 'Acme Studio' },
        businessType: { value: 'Agency / studio' },
        clients: { value: 'Businesses (B2B)' },
        salesStages: { value: 'Lead, Call, Proposal, Won' },
        taskStages: { value: 'Backlog, Doing, Review' },
        tools: { value: 'Gmail, Slack, spreadsheets' },
        pains: { value: 'Chasing invoices and following up leads' },
        aiComfort: { value: 'Always ask me first' },
      },
    });
    expect(ans.status).toBe(200);
    const an = await call(A, 'POST', `/onboarding/sessions/${s.json.session.id}/analysis`, {});
    expect(an.json.source).toBe('rules');
    expect(an.json.analysis.pipelineStages.value).toEqual(['lead', 'call', 'proposal', 'won']);
    const p = await call(A, 'POST', `/onboarding/sessions/${s.json.session.id}/proposal`, {});
    expect(p.status).toBe(201);
    expect(p.json.diff.length).toBeGreaterThan(2);
    const ap = await call(A, 'POST', `/config/versions/${p.json.version}/apply`, {});
    expect(ap.status).toBe(200);
    const cfg = await call(A, 'GET', '/config/versions');
    expect(cfg.json.current.config.taskStatuses).toEqual(['backlog', 'doing', 'review', 'done']);
    const wfs = await call(A, 'GET', '/workflows');
    const created = wfs.json.items.find((w: any) => w.name.toLowerCase().includes('client'));
    expect(created?.status).toBe('disabled');
    expect((await call(M, 'POST', `/config/versions/${p.json.version}/apply`, {})).status).toBe(403);
    // A second proposal + apply, then roll back to the first
    const p2 = await call(A, 'POST', `/onboarding/sessions/${s.json.session.id}/proposal`, {});
    await call(A, 'POST', `/config/versions/${p2.json.version}/apply`, {});
    const rb = await call(A, 'POST', `/config/versions/${p.json.version}/rollback`, {});
    expect(rb.status).toBe(200);
    expect(rb.json.restoredFrom).toBe(p.json.version);
  });

  it('workflow: publish, dry-run has no side effects, run parks at approval and resumes', async () => {
    const def = {
      trigger: { type: 'manual' },
      steps: [
        { type: 'notify', title: 'Kickoff requested for {{trigger.client}}' },
        { type: 'approval', title: 'Create the kickoff task?' },
        { type: 'action', tool: 'tasks.create', args: { title: 'WF kickoff for {{trigger.client}}' } },
      ],
    };
    // An approval-gated action without a preceding approval step cannot be published.
    const bad = await call(A, 'POST', '/workflows', { name: 'Bad', definition: { trigger: { type: 'manual' }, steps: [def.steps[2]] } });
    expect((await call(A, 'POST', `/workflows/${bad.json.id}/publish`, {})).status).toBe(400);
    const w = await call(A, 'POST', '/workflows', { name: 'Kickoff', definition: def });
    expect(w.status).toBe(201);
    expect((await call(A, 'POST', `/workflows/${w.json.id}/publish`, {})).status).toBe(200);
    const dry = await call(A, 'POST', `/workflows/${w.json.id}/dry-run`, { data: { client: 'Zed' } });
    expect(dry.status).toBe(201);
    expect((await call(A, 'GET', '/tasks?q=WF%20kickoff')).json.items.length).toBe(0);
    await call(A, 'POST', `/workflows/${w.json.id}/enable`, {});
    const run = await call(A, 'POST', `/workflows/${w.json.id}/run`, { data: { client: 'Zed' } });
    expect(run.status).toBe(201);
    const runId = run.json.id ?? run.json.runId;
    const r1 = await call(A, 'GET', `/workflow-runs/${runId}`);
    expect(r1.json.status).toBe('waiting_approval');
    expect((await call(A, 'GET', '/tasks?q=WF%20kickoff')).json.items.length).toBe(0);
    const appr = (await call(A, 'GET', '/approvals?status=pending')).json.items.find((x: any) => x.requester_kind === 'workflow');
    const dec = await call(A, 'POST', `/approvals/${appr.id}/decision`, { decision: 'approve' });
    expect(dec.status).toBe(200);
    const r2 = await call(A, 'GET', `/workflow-runs/${runId}`);
    expect(r2.json.status).toBe('completed');
    expect((await call(A, 'GET', '/tasks?q=WF%20kickoff')).json.items.length).toBe(1);
  });

  it('integrations are honest: only file import is available', async () => {
    const l = await call(A, 'GET', '/integrations');
    expect(l.json.items.filter((x: any) => x.status === 'available').map((x: any) => x.id)).toEqual(['file_import']);
    const g = await call(A, 'POST', '/integrations/google_drive/connect', {});
    expect(g.status).toBe(501);
    expect(g.json.code).toBe('CONNECTOR_NOT_CONFIGURED');
  });

  it('exports JSON for owners', async () => {
    const e = await call(A, 'GET', '/exports');
    expect(e.status).toBe(200);
    expect(e.json.data.tasks.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.json)).not.toContain('Beta Co');
  });
});
