/**
 * Phase 7 (docs/21, ADR-1 option B + M11): a person can use Qline without a business. Their personal space is an
 * ordinary organization (settings.kind='personal'), so tenant isolation is the same RLS. Needs QLINE_TEST_ENV.
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
d('Phase 7: personal space and domains', () => {
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('a new person gets a personal space without naming a business; it is one per person and cannot invite', async () => {
    const p = await signUp('Lia');
    const r = await call(p, 'POST', '/orgs', { kind: 'personal' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ name: 'Personal', role: 'owner', kind: 'personal' });
    const again = await call(p, 'POST', '/orgs', { kind: 'personal' });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(r.json.id);
    const me = await call(p, 'GET', '/me');
    expect(me.json.orgs).toEqual([expect.objectContaining({ id: r.json.id, kind: 'personal' })]);
    p.org = r.json.id;
    expect((await call(p, 'GET', '/org')).json.kind).toBe('personal');
    const inv = await call(p, 'POST', '/invitations', { role: 'member' });
    expect(inv.status).toBe(403);
    expect(inv.json.detail).toMatch(/just for you/);
    // The usual tools work there: agents exist, tasks work.
    expect((await call(p, 'GET', '/agents')).json.items.length).toBeGreaterThan(0);
    // A business still needs a name.
    expect((await call(p, 'POST', '/orgs', {})).status).toBe(400);
  });

  it('domains: seeded, renamed, hidden, added; tasks carry and filter by them; other spaces cannot use them', async () => {
    const p = await signUp('Noel');
    p.org = (await call(p, 'POST', '/orgs', { kind: 'personal' })).json.id;
    const ds = (await call(p, 'GET', '/domains')).json.items;
    expect(ds.map((x: any) => x.name)).toEqual(['Personal', 'Work', 'Learning', 'Projects', 'Health', 'Money']);
    const learning = ds.find((x: any) => x.name === 'Learning');
    expect((await call(p, 'PATCH', `/domains/${learning.id}`, { name: 'Study' })).json.name).toBe('Study');
    expect((await call(p, 'PATCH', `/domains/${ds[5].id}`, { enabled: false })).json.enabled).toBe(false);
    expect((await call(p, 'PATCH', `/domains/${ds[0].id}`, { name: 'Study' })).status).toBe(400);
    const music = await call(p, 'POST', '/domains', { name: 'Music', icon: 'music_note' });
    expect(music.status).toBe(201);
    const t1 = await call(p, 'POST', '/tasks', { title: 'Practise scales', domainId: music.json.id });
    expect(t1.status).toBe(201);
    expect(t1.json.domain_id).toBe(music.json.id);
    await call(p, 'POST', '/tasks', { title: 'Pay rent' });
    const only = await call(p, 'GET', `/tasks?domainId=${music.json.id}`);
    expect(only.json.items.map((x: any) => x.title)).toEqual(['Practise scales']);
    expect((await call(p, 'GET', '/domains')).json.items.find((x: any) => x.name === 'Music').open_tasks).toBe(1);
    // A business space of another person: cannot see or use the personal domain or tasks.
    const b = await signUp('Biz');
    b.org = (await call(b, 'POST', '/orgs', { name: 'Biz Co' })).json.id;
    expect((await call(b, 'GET', '/domains')).json.items).toEqual([]);
    expect((await call(b, 'PATCH', `/domains/${music.json.id}`, { name: 'Mine' })).status).toBe(404);
    expect((await call(b, 'POST', '/tasks', { title: 'x', domainId: music.json.id })).status).toBe(400);
    expect((await call(b, 'GET', `/tasks/${t1.json.id}`)).status).toBe(404);
    // The same person's own business space is a different scope too.
    const own = (await call(p, 'POST', '/orgs', { name: 'Noel Studio' })).json.id;
    const inBiz = { token: p.token, org: own };
    expect((await call(inBiz, 'GET', '/tasks')).json.items).toEqual([]);
    expect((await call(inBiz, 'GET', '/domains')).json.items).toEqual([]);
    expect((await call(inBiz, 'POST', '/invitations', { role: 'member' })).status).toBe(201);
  });
});
