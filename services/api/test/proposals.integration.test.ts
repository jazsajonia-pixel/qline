/**
 * Phase 6 (docs/21, M8): the AI proposes missions and agent changes; only people apply them, through the same
 * permission-checked code as the human routes. Real Postgres as the app role (RLS on). No model is called.
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
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
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
const run = (w: Who, name: string, args: unknown) =>
  db.withTenant({ orgId: w.org!, userId: w.userId!, runKind: 'interactive' }, (q) => {
    const t = tools.getTool(name)!;
    return t.execute(q, { orgId: w.org!, workspaceId: w.ws!, actor: { kind: 'agent', id: 'test-ceo' }, userId: w.userId!, interactive: true }, t.schema.parse(args));
  });
const auditActions = (w: Who, ref: string) =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => q.many<{ action: string }>('select action from audit_events where target_ref=$1 order by id', [ref])).then((r) => r.map((x) => x.action));

d('Phase 6: AI proposals for missions and agents', () => {
  let A: Who;
  let B: Who;
  let M: Who; // member of A: may use agents, may not manage them
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    A = await setup('Rosa');
    B = await setup('Ben');
    M = await signUp('Mel');
    const inv = await call(A, 'POST', '/invitations', { role: 'member' });
    expect((await call({ token: M.token }, 'POST', '/invitations/accept', { code: inv.json.code })).status).toBe(200);
    Object.assign(M, { org: A.org, ws: A.ws, userId: (await call({ token: M.token, org: A.org }, 'GET', '/me')).json.user.id });
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('a mission proposal shows in Missions, can be edited, and applying creates exactly the approved mission', async () => {
    const r = await run(A, 'missions.propose', {
      title: 'Win back lapsed customers',
      purpose: 'Email customers who have not ordered in 90 days with a small offer.',
      constraints: ['No discounts above 10%'],
      successCriteria: ['Draft emails ready for review'],
      agents: ['sales', 'marketing'],
      budgetToolCalls: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/nothing has started/);
    const id = r.refs[0]!.id;
    expect(r.artifacts).toEqual([{ type: 'proposal', id, kind: 'mission', title: 'Win back lapsed customers' }]);
    // Nothing exists yet besides the proposal.
    expect((await call(A, 'GET', '/missions')).json.items).toHaveLength(0);
    const list = await call(A, 'GET', '/proposals?kind=mission');
    expect(list.json.items.map((p: any) => p.id)).toEqual([id]);
    const one = await call(A, 'GET', `/proposals/${id}`);
    expect(one.json.goal).toContain('Success criteria:\n- Draft emails ready for review');
    expect(one.json.canApply).toBe(true);
    // Edit (strict schema, revision check).
    const bad = await call(A, 'PATCH', `/proposals/${id}`, { revision: 1, payload: { ...one.json.payload, approvalMode: 'policy' } });
    expect(bad.status).toBe(400);
    const ed = await call(A, 'PATCH', `/proposals/${id}`, { revision: 1, payload: { ...one.json.payload, constraints: ['No discounts above 5%'], budgetToolCalls: 25 } });
    expect(ed.status).toBe(200);
    expect(ed.json.status).toBe('edited');
    expect((await call(A, 'POST', `/proposals/${id}/apply`, { revision: 1 })).status).toBe(409); // stale
    const ap = await call(A, 'POST', `/proposals/${id}/apply`, { revision: 2 });
    expect(ap.status).toBe(200);
    expect(ap.json.status).toBe('applied');
    const missionId = ap.json.applied_ref.replace('mission:', '');
    const m = await call(A, 'GET', `/missions/${missionId}`);
    expect(m.status).toBe(200);
    const mission = m.json.mission ?? m.json;
    expect(mission.goal).toContain('No discounts above 5%');
    expect(mission.goal).not.toContain('10%');
    expect(mission.budget_tool_calls).toBe(25);
    expect(mission.status).toBe('planning');
    expect((await call(A, 'POST', `/proposals/${id}/apply`, { revision: 2 })).status).toBe(409); // already applied
    expect(await auditActions(A, `proposal:${id}`)).toEqual(['proposal.created', 'proposal.edited', 'proposal.applied']);
    expect(await auditActions(A, `mission:${missionId}`)).toContain('mission.created');
  });

  it('rejecting closes it; emergency stop makes apply fail visibly, and it can be retried', async () => {
    const r1 = await run(A, 'missions.propose', { title: 'Tidy the CRM', purpose: 'Merge duplicate contacts.' });
    const rej = await call(A, 'POST', `/proposals/${r1.refs[0]!.id}/reject`, { note: 'Not now' });
    expect(rej.json.status).toBe('rejected');
    expect((await call(A, 'POST', `/proposals/${r1.refs[0]!.id}/apply`, { revision: 1 })).status).toBe(409);

    const r2 = await run(A, 'missions.propose', { title: 'Price check', purpose: 'Compare our prices with three competitors.' });
    const id = r2.refs[0]!.id;
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/controls`, { emergencyStop: true })).status).toBe(200);
    const f = await call(A, 'POST', `/proposals/${id}/apply`, { revision: 1 });
    expect(f.status).toBe(409);
    const after = await call(A, 'GET', `/proposals/${id}`);
    expect(after.json.status).toBe('failed');
    expect(after.json.error).toMatch(/emergency stop/i);
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/controls`, { emergencyStop: false })).status).toBe(200);
    expect((await call(A, 'POST', `/proposals/${id}/apply`, { revision: 1 })).json.status).toBe('applied');
  });

  it('agent changes show a before/after, need agents.manage to apply, stay inside the profile, and refuse unsupported settings', async () => {
    const agents = (await call(A, 'GET', '/agents')).json.items;
    const sales = agents.find((a: any) => a.template === 'sales');
    const research = agents.find((a: any) => a.template === 'research');
    const r = await run(A, 'agents.propose_change', { agent: 'sales', instructions: 'Always answer in Tagalog first.', removeTools: ['records.search'], reason: 'User asked' });
    expect(r.ok).toBe(true);
    const id = r.refs[0]!.id;
    const one = await call(A, 'GET', `/proposals/${id}`);
    expect(one.json.diff.before.instructions).toBe(sales.instructions);
    expect(one.json.diff.after.instructions).toBe('Always answer in Tagalog first.');
    expect(one.json.diff.removed).toEqual(['records.search']);
    // A member can see it but not apply or edit it, and the proposal is untouched.
    const mv = await call(M, 'GET', `/proposals/${id}`);
    expect(mv.json.canApply).toBe(false);
    expect((await call(M, 'POST', `/proposals/${id}/apply`, { revision: 1 })).status).toBe(403);
    expect((await call(M, 'PATCH', `/proposals/${id}`, { revision: 1, payload: one.json.payload })).status).toBe(403);
    expect((await call(A, 'GET', `/proposals/${id}`)).json.status).toBe('proposed');
    // The owner applies: a new agent version with exactly the approved settings.
    const ap = await call(A, 'POST', `/proposals/${id}/apply`, { revision: 1 });
    expect(ap.status).toBe(200);
    expect(ap.json.applied_ref).toBe(`agent:${sales.id}@v${sales.current_version + 1}`);
    const now = (await call(A, 'GET', '/agents')).json.items.find((a: any) => a.id === sales.id);
    expect(now.instructions).toBe('Always answer in Tagalog first.');
    expect(now.tool_allowlist).not.toContain('records.search');
    expect(now.tool_allowlist.length).toBe(sales.tool_allowlist.length - 1);
    // Undo is the existing version revert.
    expect((await call(A, 'POST', `/agents/${sales.id}/revert`, { version: sales.current_version })).status).toBe(200);
    // Outside the profile: refused at proposal time.
    const wide = await run(A, 'agents.propose_change', { agent: research.name, addTools: ['github.issue.create'] });
    expect(wide.ok).toBe(false);
    expect(wide.summary).toMatch(/not available/);
    // Unsupported settings never reach the database.
    const t = tools.getTool('agents.propose_change')!;
    for (const extra of [{ approvalMode: 'policy' }, { keyId: randomUUID() }, { status: 'active' }, { maxToolCalls: 8 }]) expect(t.schema.safeParse({ agent: 'sales', ...extra }).success).toBe(false);
    expect(tools.getTool('missions.propose')!.schema.safeParse({ title: 'Billing', purpose: 'Change plan', plan: 'pro' }).success).toBe(false);
    expect((await run(A, 'agents.propose_change', { agent: 'sales' })).ok).toBe(false);
    expect((await run(A, 'agents.propose_change', { agent: 'Nobody', name: 'X' })).summary).toMatch(/No agent/);
  });

  it('another organization cannot see or act on a proposal', async () => {
    const r = await run(A, 'missions.propose', { title: 'Secret plan', purpose: 'Only for org A.' });
    const id = r.refs[0]!.id;
    expect((await call(B, 'GET', `/proposals/${id}`)).status).toBe(404);
    expect((await call(B, 'POST', `/proposals/${id}/apply`, { revision: 1 })).status).toBe(404);
    expect((await call(B, 'POST', `/proposals/${id}/reject`, {})).status).toBe(404);
    expect((await call(B, 'GET', '/proposals')).json.items).toHaveLength(0);
  });
});
