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

  it('integrations: honest until registered, OAuth login stores sealed tokens, Gmail + Sheets sync make leads, triggers workflows', async () => {
    const l = await call(A, 'GET', '/integrations');
    expect(l.status).toBe(200);
    expect(l.json.providers.map((p: any) => p.id)).toEqual(['google', 'microsoft', 'slack']);
    expect(l.json.providers.every((p: any) => !p.registered && !p.connection)).toBe(true);
    expect(l.json.canSetup).toBe(false);
    const g0 = await call(A, 'POST', '/integrations/google/connect', {});
    expect(g0.status).toBe(409);
    expect(g0.json.code).toBe('INTEGRATION_NOT_REGISTERED');
    expect((await call(A, 'PUT', '/platform/oauth-apps/google', { clientId: 'client-123456', clientSecret: 'secret-abcdef-XYZ' })).status).toBe(403);

    const me = await call(A, 'GET', '/me');
    const email = me.json.user?.email ?? me.json.email;
    const prevAdmins = process.env.QLINE_PLATFORM_ADMINS;
    process.env.QLINE_PLATFORM_ADMINS = email;
    const realFetch = globalThis.fetch;
    const appended: any[] = [];
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const b64 = (s: string) => Buffer.from(s).toString('base64url');
    const gmsg = (id: string, from: string, subject: string, text: string, extra: any[] = []) => ({
      id,
      internalDate: String(Date.now() - 60_000),
      snippet: text.slice(0, 50),
      payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...extra], parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }] },
    });
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      if (url.startsWith('https://oauth2.googleapis.com/token'))
        return j({ access_token: 'at-SECRET-1', refresh_token: 'rt-SECRET-1', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events' });
      if (url.startsWith('https://oauth2.googleapis.com/revoke')) return j({});
      if (url.startsWith('https://openidconnect.googleapis.com')) return j({ email: 'owner@acme.test', name: 'Acme Owner' });
      if (url.includes('/gmail/v1/users/me/messages?')) return j({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
      if (url.includes('/gmail/v1/users/me/messages/m1')) return j(gmsg('m1', 'Dana Buyer <dana@bigco.test>', 'Pricing for 20 seats', 'Hi, we are interested in pricing and need a quote today. Call +63 917 555 0101.'));
      if (url.includes('/gmail/v1/users/me/messages/m2')) return j(gmsg('m2', 'News <news@letters.test>', 'Weekly pricing digest', 'Big sale on pricing', [{ name: 'List-Unsubscribe', value: '<mailto:x@y>' }]));
      if (url.includes('/gmail/v1/users/me/messages/m3')) return j(gmsg('m3', 'Pat Friend <pat@friends.test>', 'Lunch?', 'Free for lunch on Friday?'));
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && method === 'POST') return j({ spreadsheetId: 'S1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/S1' });
      if (url.includes('/spreadsheets/S1/values/Leads!A2:J2000')) return j({ values: [['', 'Row Lead', 'row@lead.test', '', 'Row Co', 'lead', 'high', 'Wants a demo', '', '']] });
      if (url.includes('/spreadsheets/S1/values/') && url.includes(':append')) {
        appended.push(JSON.parse(init.body));
        return j({});
      }
      if (url.includes('/spreadsheets/S1/values/')) return j({});
      return realFetch(input, init);
    }) as any;
    let turn = 0;
    ai.setTestProvider(
      new ai.MockProvider((req) => {
        turn++;
        const u = String(req.messages.at(-1)?.content ?? '');
        const out = u.includes('Pricing for 20 seats')
          ? { is_lead: true, urgency: 'urgent', score: 92, summary: 'Wants a quote for 20 seats today', reason: 'Explicit buying intent with a same-day deadline', name: 'Dana Buyer', company: 'BigCo', phone: '+63 917 555 0101' }
          : { is_lead: false, urgency: 'low', score: 5, summary: 'Not business', reason: 'Personal or newsletter', name: null, company: null, phone: null };
        return [{ type: 'token', text: 'Here you go: ' + JSON.stringify(out) }, { type: 'done' }];
      }),
    );
    try {
      const s1 = await call(A, 'PUT', '/platform/oauth-apps/google', { clientId: 'client-123456.apps.googleusercontent.com', clientSecret: 'secret-abcdef-XYZ' });
      expect(s1.status).toBe(200);
      const apps = await call(A, 'GET', '/platform/oauth-apps');
      expect(apps.json.items.find((x: any) => x.id === 'google')).toMatchObject({ configured: true });
      expect(apps.json.items.find((x: any) => x.id === 'google').redirectUri).toMatch(/\/v1\/integrations\/google\/callback$/);
      expect(JSON.stringify(apps.json)).not.toContain('secret-abcdef');
      expect((await call(M, 'POST', '/integrations/google/connect', {})).status).toBe(403); // viewer

      const recipe = await call(A, 'POST', '/workflow-recipes/urgent_lead_alert/install', {});
      expect(recipe.status).toBe(201);
      expect((await call(A, 'POST', '/workflow-recipes/urgent_lead_alert/install', {})).status).toBe(409);

      const cn = await call(A, 'POST', '/integrations/google/connect', { features: ['gmail', 'sheets'] });
      expect(cn.status).toBe(200);
      const u = new URL(cn.json.url);
      expect(u.host).toBe('accounts.google.com');
      expect(u.searchParams.get('scope')).toContain('gmail.readonly');
      expect(u.searchParams.get('scope')).toContain('drive.file');
      expect(u.searchParams.get('scope')).not.toContain('calendar');
      expect(u.searchParams.get('access_type')).toBe('offline');
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
      const state = u.searchParams.get('state')!;
      const bad = await call(null, 'GET', `/integrations/google/callback?state=nope&code=x`);
      expect(bad.status).toBe(400);
      const cb = await call(null, 'GET', `/integrations/google/callback?state=${state}&code=good-code`);
      expect(cb.status).toBe(200);
      expect(String(cb.json)).toContain('Google connected');
      expect(String(cb.json)).toContain('qline://integrations');
      expect((await call(null, 'GET', `/integrations/google/callback?state=${state}&code=good-code`)).status).toBe(400); // single use

      const l2 = await call(A, 'GET', '/integrations');
      const gc = l2.json.providers.find((p: any) => p.id === 'google').connection;
      expect(gc).toMatchObject({ accountEmail: 'owner@acme.test', status: 'ok' });
      expect(gc.features).toEqual(expect.arrayContaining(['gmail', 'sheets', 'forms', 'calendar']));
      expect(JSON.stringify(l2.json)).not.toContain('SECRET');
      expect((await call(B, 'GET', '/integrations')).json.providers.find((p: any) => p.id === 'google').connection).toBeNull();

      // AI triage needs a model: connect a (mocked) provider the way the API stores it.
      const { seal } = await import('../src/core/secrets');
      const { aad } = await import('../src/agent/models');
      const { withTenant } = await import('../src/core/db');
      await withTenant({ orgId: A.org!, userId: me.json.user?.id ?? me.json.id }, (q) =>
        q.exec(`insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test') on conflict do nothing`, [
          A.org,
          seal('sk-ant-test-key', aad(A.org!, 'anthropic')),
          JSON.stringify([{ id: 'claude-test', name: 'Claude Test' }]),
        ]),
      );
      expect((await call(A, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(200);

      const sync = await call(A, 'POST', '/integrations/google/sync', {});
      expect(sync.status).toBe(200);
      expect(sync.json).toMatchObject({ checked: 3, leads: 1 });
      await (await import('../src/runtime/jobs')).settleKicks(); // v1.4: event workflows run on background workers
      const inbox = await call(A, 'GET', '/leads/inbox');
      expect(inbox.json.counts).toMatchObject({ leads: 1, urgent: 1, ignored: 2 });
      const dana = inbox.json.items.find((x: any) => x.from_email === 'dana@bigco.test');
      expect(dana).toMatchObject({ is_lead: true, urgency: 'urgent', classified_by: 'ai' });
      const news = inbox.json.items.find((x: any) => x.from_email === 'news@letters.test');
      expect(news.is_lead).toBe(false);
      const cs = await call(A, 'GET', '/contacts?q=Dana');
      expect(cs.json.items[0]).toMatchObject({ stage: 'lead', urgency: 'urgent', phone: '+63 917 555 0101' });
      expect((await call(B, 'GET', '/leads/inbox')).json.items.length).toBe(0);
      const notes = await call(A, 'GET', '/notifications');
      expect(JSON.stringify(notes.json)).toContain('Urgent lead: Dana Buyer');
      const pend = await call(A, 'GET', '/approvals?status=pending');
      expect(JSON.stringify(pend.json)).toContain('Post Dana Buyer to Slack and create a reply task?');
      // dedupe
      expect((await call(A, 'POST', '/integrations/google/sync', {})).json.leads).toBe(0);

      // Sheets: create, import a row added by hand, export Qline leads
      const sh = await call(A, 'POST', '/integrations/google/sheet', {});
      expect(sh.status).toBe(201);
      expect(sh.json.sheet.id).toBe('S1');
      expect((await call(A, 'GET', '/contacts?q=Row%20Lead')).json.items[0]).toMatchObject({ stage: 'lead', urgency: 'high' });
      expect(JSON.stringify(appended)).toContain('dana@bigco.test');
      expect(JSON.stringify(appended)).not.toContain('row@lead.test'); // already in the sheet

      // People can correct the AI
      const pat = inbox.json.items.find((x: any) => x.from_email === 'pat@friends.test');
      const mk = await call(A, 'POST', `/leads/inbox/${pat.id}/mark`, { lead: true, urgency: 'normal' });
      expect(mk.json).toMatchObject({ is_lead: true, status: 'lead' });
      expect(mk.json.contact_id).toBeTruthy();
      const nk = await call(A, 'POST', `/leads/inbox/${news.id}/mark`, { lead: false, ignoreSender: true });
      expect(nk.status).toBe(200);
      const rules = await call(A, 'GET', '/leads/rules');
      expect(rules.json.ignoreDomains).toContain('letters.test');
      ai.setTestProvider(null);
      const put = await call(A, 'PUT', '/leads/rules', { ...rules.json, useAi: false, urgentKeywords: ['rush'], vipDomains: ['vip.test'] });
      expect(put.status).toBe(200);
      expect((await call(M, 'PUT', '/leads/rules', rules.json)).status).toBe(403);
      const t1 = await call(A, 'POST', '/leads/rules/test', { from: 'ceo@vip.test', subject: 'Quick question', text: 'rush please' });
      expect(t1.json).toMatchObject({ isLead: true, urgency: 'urgent', by: 'rules' });
      const t2 = await call(A, 'POST', '/leads/rules/test', { from: 'a@letters.test', subject: 'Pricing', text: 'interested' });
      expect(t2.json.isLead).toBe(false);

      expect((await call(A, 'DELETE', '/integrations/google')).status).toBe(200);
      expect((await call(A, 'GET', '/integrations')).json.providers.find((p: any) => p.id === 'google').connection).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      ai.setTestProvider(null);
      process.env.QLINE_PLATFORM_ADMINS = prevAdmins ?? '';
      await call(A, 'PUT', '/ai/default', { provider: null });
      await call(A, 'DELETE', '/ai/providers/anthropic');
      const { deleteApp } = await import('../src/integrations/oauth');
      await deleteApp('google');
    }
    expect(turn).toBeGreaterThan(0);
  });

  it('automation steps: email needs approval, dry run simulates AI/Slack/email, voice is honest without keys', async () => {
    const bad = await call(A, 'POST', '/workflows', {
      name: 'Bad mailer',
      definition: { trigger: { type: 'manual' }, steps: [{ type: 'email', to: 'x@y.test', subject: 'Hi', body: 'Hello' }] },
    });
    expect(bad.status).toBe(201);
    const pub = await call(A, 'POST', `/workflows/${bad.json.id}/publish`, {});
    expect(pub.status).toBe(400);
    const ok = await call(A, 'POST', '/workflows', {
      name: 'Reply flow',
      definition: {
        trigger: { type: 'event', event: 'lead.created' },
        steps: [
          { type: 'ai', prompt: 'Write a reply to {{trigger.name}}', saveAs: 'reply' },
          { type: 'approval', title: 'Send?' },
          { type: 'slack', text: 'New lead {{trigger.name}}' },
          { type: 'email', to: '{{trigger.email}}', subject: 'Re: hi', body: '{{reply}}' },
          { type: 'calendar', title: 'Follow up {{trigger.name}}', inDays: 2 },
        ],
      },
    });
    expect((await call(A, 'POST', `/workflows/${ok.json.id}/publish`, {})).status).toBe(200);
    const dr = await call(A, 'POST', `/workflows/${ok.json.id}/dry-run`, { data: { name: 'Sam', email: 'sam@x.test' } });
    expect(dr.status).toBe(201);
    expect(dr.json.steps.map((s: any) => s.status)).toEqual(['simulated', 'simulated', 'simulated', 'simulated', 'simulated']);
    const rec = await call(A, 'GET', '/workflow-recipes');
    expect(rec.json.items.map((r: any) => r.id)).toEqual(['urgent_lead_alert', 'lead_auto_reply', 'lead_follow_up', 'daily_briefing', 'important_email_task', 'overdue_nudge', 'evening_wrap', 'weekly_review']);
    expect(rec.json.items.find((r: any) => r.id === 'urgent_lead_alert').installed).toBe(true);

    const vo = await call(A, 'GET', '/voice/options');
    expect(vo.json.engines.find((e: any) => e.id === 'gemini').available).toBe(false);
    const sp = await call(A, 'POST', '/voice/speak', { text: 'Hello there', engine: 'gemini' });
    expect(sp.status).toBe(409);
    expect(sp.json.code).toBe('VOICE_NOT_CONFIGURED');
  });

  it('exports JSON for owners', async () => {
    const e = await call(A, 'GET', '/exports');
    expect(e.status).toBe(200);
    expect(e.json.data.tasks.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.json)).not.toContain('Beta Co');
  });
});
