/**
 * v1.6 autonomy, delegation and new tools against a real Postgres, as the app role (RLS enforced).
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import('../src/core/db');
let tools: typeof import('../src/agent/tools');

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

async function setup(name: string): Promise<Who> {
  const w = await signUp(name);
  w.org = (await call(w, 'POST', '/orgs', { name: `${name} Co` })).json.id;
  w.userId = (await call(w, 'GET', '/me')).json.user.id;
  w.ws = (await db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => q.one('select id from workspaces where org_id=$1', [w.org])))!.id;
  return w;
}

/** Run a tool the way the agent runner does: inside the tenant transaction, as an agent. */
const run = (w: Who, name: string, args: unknown) =>
const activate = async (w: Who, templates: string[]) => {
  const agents = (await call(w, 'GET', '/agents')).json.items;
  for (const a of agents.filter((x: any) => templates.includes(x.template))) expect((await call(w, 'PATCH', `/agents/${a.id}`, { status: 'active' })).status).toBe(200);
};

d('v1.6 autonomy and delegation (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    A = await setup('Lani');
    B = await setup('Rio');
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('new workspaces give the CEO the delegation tools and operations the Slack channel tools', async () => {
    const agents = (await call(A, 'GET', `/agents`)).json.items;
    const allow = async (template: string) => {
      const a = agents.find((x: any) => x.template === template);
      return (await call(A, 'GET', `/agents/${a.id}`)).json.tool_allowlist as string[];
    };
    expect(await allow('ceo')).toEqual(expect.arrayContaining(['agents.delegate', 'agents.status', 'companies.update', 'projects.update', 'slack.channel.create']));
    expect(await allow('sales')).not.toContain('agents.delegate');
    expect(await allow('operations')).toEqual(expect.arrayContaining(['slack.channel.create', 'slack.channel.topic', 'projects.update']));
  });

  it('autonomy defaults to supervised; only this workspace owner can change it, and it is audited', async () => {
    const g = await call(A, 'GET', `/workspaces/${A.ws}/autonomy`);
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ autonomy: 'supervised', canChange: true, dailyExternalLimit: 25 });
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'reckless' })).status).toBe(400);
    expect((await call(B, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'full' })).status).toBe(404);
    const p = await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'full', dailyExternalLimit: 5 });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ autonomy: 'full', dailyExternalLimit: 5, externalToday: 0, externalCapReached: false });
    const audit = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one(`select detail from audit_events where action='autonomy.changed' order by id desc limit 1`));
    expect(audit?.detail).toMatchObject({ from: 'supervised', to: 'full' });
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'supervised' })).json.autonomy).toBe('supervised');
    // Other workspace config is preserved.
    const cfg = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one('select config from workspaces where id=$1', [A.ws]));
    expect(cfg.config.terminology).toBeTruthy();
  });

  it('companies.update and projects.update edit only this tenant', async () => {
    const c = await run(A, 'companies.create', { name: 'Durian Supply' });
    const id = c.refs[0]!.id;
    expect((await run(A, 'companies.update', { companyId: id, domain: 'https://durian.ph/about', notes: 'Main fruit supplier' })).ok).toBe(true);
    const row = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one('select domain, notes from companies where id=$1', [id]));
    expect(row).toMatchObject({ domain: 'durian.ph', notes: 'Main fruit supplier' });
    expect((await run(B, 'companies.update', { companyId: id, notes: 'hijack' })).ok).toBe(false);
    const p = await run(A, 'projects.create', { name: 'Store opening' });
    const u = await run(A, 'projects.update', { projectId: p.refs[0]!.id, status: 'on_hold' });
    expect(u).toMatchObject({ ok: true });
    expect(u.summary).toContain('on_hold');
    expect((await run(B, 'projects.update', { projectId: p.refs[0]!.id, status: 'done' })).ok).toBe(false);
  });

  it('slack channel tools explain when Slack is not connected', async () => {
    expect((await run(A, 'slack.channel.create', { name: 'Sales Leads!' })).summary).toContain('Slack is not connected');
    expect((await run(A, 'slack.channel.topic', { channel: 'general', topic: 'x' })).summary).toContain('Slack is not connected');
  });

  it('agents.delegate: paused agents fail, supervised hand-offs wait for approval, autopilot starts them', async () => {
    expect((await run(A, 'agents.delegate', { agent: 'research', title: 'Competitor prices', instructions: 'List 3 competitors and prices' })).summary).toContain('paused');
    await activate(A, ['research']);
    const s = await run(A, 'agents.delegate', { agent: 'research', title: 'Competitor prices', instructions: 'List 3 competitors and prices' });
    expect(s.ok).toBe(true);
    const m1 = (s.data as any).missionId;
    const g1 = await call(A, 'GET', `/missions/${m1}`);
    expect(g1.json.status).toBe('awaiting_plan_approval');
    expect(g1.json.plan.status).toBe('proposed');
    expect(g1.json.plan.plan.tasks[0]).toMatchObject({ agent: 'research', title: 'Competitor prices' });

    await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'autopilot' });
    const a = await run(A, 'agents.delegate', { agent: 'research', title: 'Supplier list', instructions: 'Find 3 suppliers' });
    expect(a.ok).toBe(true);
    const g2 = await call(A, 'GET', `/missions/${(a.data as any).missionId}`);
    expect(g2.json.status).toBe('running');
    expect(g2.json.plan.status).toBe('approved');
    expect(g2.json.tasks).toHaveLength(1);
    expect(['queued', 'ready', 'running']).toContain(g2.json.tasks[0].status);
    const st = await run(A, 'agents.status', { missionId: (a.data as any).missionId });
    expect(st.summary).toContain('Supplier list');
    // Cross-tenant: B cannot see A's missions.
    expect((await run(B, 'agents.status', { missionId: (a.data as any).missionId })).ok).toBe(false);
    // Emergency stop blocks delegation.
    await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) =>
      q.exec(`insert into workspace_controls (org_id, workspace_id, emergency_stop) values ($1,$2,true) on conflict (workspace_id) do update set emergency_stop=true`, [A.org, A.ws]),
    );
    expect((await run(A, 'agents.delegate', { agent: 'research', title: 'Again', instructions: 'x y z' })).summary).toContain('Emergency stop');
    await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.exec(`update workspace_controls set emergency_stop=false where workspace_id=$1`, [A.ws]));
    await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'supervised' });
  });

  it("'auto' routes a chat message to the matching active specialist, else keeps the conversation agent", async () => {
    const conv = (await call(A, 'POST', '/conversations', {})).json;
    const r1 = await call(A, 'POST', `/conversations/${conv.id}/messages`, { content: 'Research our competitors and market trends', agent: 'auto' });
    expect(r1.status).toBe(202);
    expect(r1.json.agent.template).toBe('research');
    const run1 = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one('select a.template from agent_runs r join agents a on a.id=r.agent_id where r.id=$1', [r1.json.runId]));
    expect(run1.template).toBe('research');
    await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.exec(`update agent_runs set status='completed' where id=$1`, [r1.json.runId]));
    // Finance is paused, so a finance question stays with the CEO.
    const r2 = await call(A, 'POST', `/conversations/${conv.id}/messages`, { content: 'What is our revenue and profit margin?', agent: 'auto' });
    expect(r2.json.agent.template).toBe('ceo');
    await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.exec(`update agent_runs set status='completed' where id=$1`, [r2.json.runId]));
    expect((await call(A, 'POST', `/conversations/${conv.id}/messages`, { content: 'hi', agent: randomUUID() })).status).toBe(404);
    // Messages carry a meta object (speech + suggestions) for the app.
    const g = await call(A, 'GET', `/conversations/${conv.id}`);
    expect(g.json.messages[0]).toHaveProperty('meta');
  });
});
