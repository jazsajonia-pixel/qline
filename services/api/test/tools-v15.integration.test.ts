/**
 * v1.5 assistant tools against a real Postgres, as the app role (RLS enforced).
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
  db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => {
    const t = tools.getTool(name)!;
    return t.execute(q, { orgId: w.org!, workspaceId: w.ws!, actor: { kind: 'agent', id: 'test-agent' }, userId: w.userId! }, t.schema.parse(args));
  });

d('v1.5 assistant tools (integration)', () => {
  let A: Who;
  let B: Who;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    A = await setup('Tala');
    B = await setup('Ben');
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('new workspaces give agents the new tools by template', async () => {
    const agents = (await call(A, 'GET', '/agents')).json.items as any[];
    const names = (tpl: string) => (agents.find((a) => a.template === tpl)?.tools ?? []).map((t: any) => t.name);
    for (const tpl of ['ceo', 'research']) for (const n of ['time.now', 'documents.read', 'contacts.get', 'projects.list', 'business.snapshot', 'sheets.read']) expect(names(tpl), `${tpl}:${n}`).toContain(n);
    expect(names('sales')).toEqual(expect.arrayContaining(['companies.create', 'slack.channels', 'tasks.comment', 'sheets.append']));
    expect(names('research')).not.toContain('companies.create');
    expect(names('research')).not.toContain('sheets.append');
    expect(names('ceo')).toContain('projects.create');
    expect(names('sales')).not.toContain('projects.create');
  });

  it('time.now returns a valid time and falls back to UTC for an unknown zone', async () => {
    const r = await run(A, 'time.now', { timeZone: 'Not/AZone' });
    expect(r.ok).toBe(true);
    expect((r.data as any).timeZone).toBe('UTC');
    expect(Math.abs(Date.parse((r.data as any).iso) - Date.now())).toBeLessThan(60_000);
    expect(((await run(A, 'time.now', { timeZone: 'Asia/Manila' })).data as any).timeZone).toBe('Asia/Manila');
  });

  it('companies.create adds once and recognises duplicates by name or domain', async () => {
    const a = await run(A, 'companies.create', { name: 'Mabuhay Foods', domain: 'https://www.mabuhay.example/about' });
    expect(a.ok).toBe(true);
    expect(a.summary).toContain('Added company');
    const dupName = await run(A, 'companies.create', { name: 'mabuhay foods' });
    expect(dupName.summary).toContain('already');
    expect(dupName.refs[0]!.id).toBe(a.refs[0]!.id);
    const dupDomain = await run(A, 'companies.create', { name: 'Mabuhay Foods Inc', domain: 'www.mabuhay.example' });
    expect(dupDomain.refs[0]!.id).toBe(a.refs[0]!.id);
    // Other tenants never see it.
    expect((await run(B, 'companies.create', { name: 'Mabuhay Foods' })).summary).toContain('Added company');
  });

  it('projects, task comments, documents and contact lookup work and stay in the tenant', async () => {
    const p = await run(A, 'projects.create', { name: 'Launch', description: 'Q1 launch' });
    expect(p.ok).toBe(true);
    const projectId = p.refs[0]!.id;
    const task = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) =>
      q.one(`insert into tasks (org_id, workspace_id, project_id, title, due_at, created_by) values ($1,$2,$3,'Call Dana Cruz', now() - interval '1 day', 'test') returning id`, [A.org, A.ws, projectId]),
    );
    const list = await run(A, 'projects.list', {});
    const row = (list.data as any[]).find((x) => x.id === projectId);
    expect(Number(row.open_tasks)).toBe(1);
    expect(Number(row.overdue_tasks)).toBe(1);
    expect((await run(B, 'projects.list', { status: 'all' })).data).toEqual([]);

    const c = await run(A, 'tasks.comment', { taskId: task!.id, body: 'Left a voicemail' });
    expect(c.ok).toBe(true);
    expect((await run(B, 'tasks.comment', { taskId: task!.id, body: 'x' })).ok).toBe(false);

    const note = await run(A, 'notes.create', { title: 'Pricing', body: 'Standard plan is 999 PHP a month.' });
    const doc = await run(A, 'documents.read', { documentId: note.refs[0]!.id });
    expect((doc.data as any).body).toContain('999 PHP');
    expect((await run(B, 'documents.read', { documentId: note.refs[0]!.id })).ok).toBe(false);

    const contact = await run(A, 'contacts.create', { name: 'Dana Cruz', email: 'dana@example.com', stage: 'lead' });
    const got = await run(A, 'contacts.get', { contactId: contact.refs[0]!.id });
    expect((got.data as any).email).toBe('dana@example.com');
    expect((got.data as any).openTasks.map((t: any) => t.id)).toContain(task!.id);
    expect((await run(B, 'contacts.get', { contactId: contact.refs[0]!.id })).ok).toBe(false);
  });

  it('business.snapshot counts this tenant only', async () => {
    const s = (await run(A, 'business.snapshot', {})).data as any;
    expect(s.tasks.open).toBeGreaterThanOrEqual(1);
    expect(s.tasks.overdue).toBeGreaterThanOrEqual(1);
    expect(s.contactsByStage.lead).toBeGreaterThanOrEqual(1);
    const sb = (await run(B, 'business.snapshot', {})).data as any;
    expect(sb.tasks.open).toBe(0);
    expect(sb.contactsByStage).toEqual({});
  });

  it('Sheets and Slack tools explain what to connect instead of failing', async () => {
    const sr = await run(A, 'sheets.read', { sheet: 'https://docs.google.com/spreadsheets/d/1c2gnCSAyD8dVisRAYwbNPtF3Om1xJiccVoDXAF-x0ns/edit' });
    expect(sr.ok).toBe(false);
    expect(sr.summary).toContain('Google is not connected');
    expect((await run(A, 'sheets.append', { sheet: 'not a sheet', rows: [['a']] })).summary).toContain('not a Google Sheets link');
    expect((await run(A, 'slack.channels', {})).summary).toContain('Slack is not connected');
    expect((await run(A, 'slack.post', { text: 'hi', channel: '#sales' })).summary).toContain('Slack is not connected');
  });
});
