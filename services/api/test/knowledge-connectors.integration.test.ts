/**
 * v1.6 run 3: Knowledge OS (private/shared entries, revisions, links, graph) and the
 * Drive / Notion / GitHub / Stripe connector tools, against a real Postgres as the app role
 * (RLS enforced). External APIs are replaced by a fetch stub; nothing leaves the machine.
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import('../src/core/db');
let tools: typeof import('../src/agent/tools');
let oauth: typeof import('../src/integrations/oauth');

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

/** Runs a tool like the chat runner does (interactive) or like a background mission (system). */
const run = (w: Who, name: string, args: unknown, interactive = true) =>
  db.withTenant({ orgId: w.org!, userId: w.userId!, runKind: interactive ? 'interactive' : 'system' }, (q) => {
    const t = tools.getTool(name)!;
    return t.execute(q, { orgId: w.org!, workspaceId: w.ws!, actor: { kind: 'agent', id: 'test-agent' }, userId: w.userId!, interactive }, t.schema.parse(args));
  });

/** Stores a fake connection for a provider (sealed exactly like the OAuth callback does). */
const connect = (w: Who, provider: string, scopes: string[], token = `tok-${provider}`) =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) =>
    q.exec(
      `insert into integration_connections (org_id, workspace_id, provider, account_name, scopes, token_ciphertext, status, connected_by) values ($1,$2,$3,'Test',$4,$5,'ok',$6)
       on conflict (org_id, provider) do update set scopes=excluded.scopes, token_ciphertext=excluded.token_ciphertext, status='ok'`,
      [w.org, w.ws, provider, scopes, oauth.sealTokens(w.org!, provider, { access_token: token }), w.userId],
    ),
  );

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };
const realFetch = globalThis.fetch;
let seen: Seen[] = [];
/** Replaces fetch for external hosts only; routes return canned JSON. */
function stub(routes: [RegExp, (s: Seen) => { status?: number; json?: unknown; text?: string }][]) {
  seen = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const s = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? init.body : '' };
    seen.push(s);
    const r = routes.find(([re]) => re.test(`${s.method} ${url}`));
    if (!r) return new Response(JSON.stringify({ error: { message: `unstubbed ${s.method} ${url}` } }), { status: 599 });
    const out = r[1](s);
    return new Response(out.text ?? JSON.stringify(out.json ?? {}), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

d('v1.6 run 3: Knowledge OS and connectors (integration)', () => {
  let A: Who; // owner of org A
  let M: Who; // a member of org A
  let B: Who; // another organization
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    oauth = await import('../src/integrations/oauth');
    A = await setup('Mara');
    B = await setup('Tomas');
    M = await signUp('Joy');
    const inv = await call(A, 'POST', '/invitations', { role: 'member' });
    expect((await call({ token: M.token }, 'POST', '/invitations/accept', { code: inv.json.code })).status).toBe(200);
    M.org = A.org;
    M.userId = (await call(M, 'GET', '/me')).json.user.id;
    M.ws = A.ws;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('seeds the default categories once and lets only managers+ organize them', async () => {
    const c = await call(A, 'GET', '/knowledge/categories');
    expect(c.status).toBe(200);
    expect(c.json.items.map((x: any) => x.key)).toEqual(expect.arrayContaining(['business', 'processes', 'decisions', 'inbox']));
    expect(c.json.canOrganize).toBe(true);
    expect((await call(M, 'GET', '/knowledge/categories')).json.canOrganize).toBe(false);
    expect((await call(M, 'POST', '/knowledge/categories', { name: 'Member made' })).status).toBe(403);
    const n = (await call(A, 'GET', '/knowledge/categories')).json.items.length;
    expect(n).toBe(c.json.items.length);
  });

  it('private entries are invisible to other members, to background runs and to other orgs', async () => {
    const p = await call(A, 'POST', '/knowledge/entries', { title: 'Supplier discount', body: 'Durian Supply gives us 12% off above 50 kg.', kind: 'fact' });
    expect(p.status).toBe(201);
    expect(p.json).toMatchObject({ visibility: 'private', owner_user_id: A.userId, revision: 1 });
    const id = p.json.id;
    expect((await call(A, 'GET', `/knowledge/entries/${id}`)).status).toBe(200);
    expect((await call(A, 'GET', '/knowledge/entries?q=durian')).json.items.map((x: any) => x.id)).toContain(id);
    // Another member of the same organization cannot see, find, edit or share it.
    expect((await call(M, 'GET', `/knowledge/entries/${id}`)).status).toBe(404);
    expect((await call(M, 'GET', '/knowledge/entries?q=durian')).json.items).toEqual([]);
    expect((await call(M, 'PATCH', `/knowledge/entries/${id}`, { body: 'hijack', ifRevision: 1 })).status).toBe(404);
    expect((await call(M, 'POST', `/knowledge/entries/${id}/share`)).status).toBe(404);
    // The legacy /memory list respects the same rule.
    expect((await call(M, 'GET', '/memory')).json.items?.map((x: any) => x.id) ?? []).not.toContain(id);
    // Same user, but a background run (mission/workflow/job): the database hides it.
    const sys = await db.withTenant({ orgId: A.org!, userId: A.userId!, runKind: 'system' }, (q) => q.one('select id from memory_records where id=$1', [id]));
    expect(sys).toBeNull();
    const inter = await db.withTenant({ orgId: A.org!, userId: A.userId!, runKind: 'interactive' }, (q) => q.one('select id from memory_records where id=$1', [id]));
    expect(inter?.id).toBe(id);
    // Revisions of a hidden entry are hidden too.
    const rev = await db.withTenant({ orgId: A.org!, userId: M.userId!, runKind: 'interactive' }, (q) => q.many('select * from knowledge_revisions where entry_id=$1', [id]));
    expect(rev).toEqual([]);
    // Another organization sees nothing.
    expect((await call(B, 'GET', `/knowledge/entries/${id}`)).status).toBe(404);

    // Sharing makes it visible to the member; unsharing hides it again. Both are revisions.
    const s = await call(A, 'POST', `/knowledge/entries/${id}/share`);
    expect(s.json).toMatchObject({ visibility: 'workspace', revision: 2 });
    expect((await call(M, 'GET', `/knowledge/entries/${id}`)).status).toBe(200);
    expect((await call(M, 'POST', `/knowledge/entries/${id}/unshare`)).status).toBe(403);
    expect((await call(A, 'POST', `/knowledge/entries/${id}/unshare`)).json.visibility).toBe('private');
    expect((await call(M, 'GET', `/knowledge/entries/${id}`)).status).toBe(404);
    const detail = (await call(A, 'GET', `/knowledge/entries/${id}`)).json;
    expect(detail.revisions.map((r: any) => r.change_kind)).toEqual(['unshare', 'share', 'create']);
  });

  it('edits need the current revision (409 on a stale one) and deletes are soft', async () => {
    const e = (await call(A, 'POST', '/knowledge/entries', { title: 'Opening hours', body: '9 to 6', kind: 'policy', visibility: 'workspace' })).json;
    const ok = await call(M, 'PATCH', `/knowledge/entries/${e.id}`, { body: '9 to 7', ifRevision: 1 });
    expect(ok.status).toBe(200);
    expect(ok.json.revision).toBe(2);
    const stale = await call(A, 'PATCH', `/knowledge/entries/${e.id}`, { body: '8 to 5', ifRevision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('REVISION_CONFLICT');
    expect((await call(A, 'DELETE', `/knowledge/entries/${e.id}`)).status).toBe(200);
    expect((await call(A, 'GET', `/knowledge/entries/${e.id}`)).status).toBe(404);
    const row = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one('select deleted_at from memory_records where id=$1', [e.id]));
    expect(row?.deleted_at).toBeTruthy();
  });

  it('links: shared entries cannot point at private ones; the graph shows links and respects caps', async () => {
    const shared = (await call(A, 'POST', '/knowledge/entries', { title: 'Refund policy', body: 'Refunds within 7 days.', kind: 'policy', visibility: 'workspace' })).json;
    const priv = (await call(A, 'POST', '/knowledge/entries', { title: 'Why we chose 7 days', body: 'Cash flow.', kind: 'decision' })).json;
    const bad = await call(A, 'POST', '/knowledge/links', { fromEntry: shared.id, toType: 'entry', toId: priv.id, relation: 'decided_in' });
    expect(bad.status).toBe(409);
    expect(bad.json.code).toBe('PRIVATE_TARGET');
    // Private → shared is fine, and then sharing the private one is blocked only if it points at something private.
    expect((await call(A, 'POST', '/knowledge/links', { fromEntry: priv.id, toType: 'entry', toId: shared.id, relation: 'about' })).status).toBe(201);
    const contact = (await call(A, 'POST', '/contacts', { name: 'Ana Reyes', email: `ana-${randomUUID().slice(0, 6)}@x.test` })).json;
    const l = await call(A, 'POST', '/knowledge/links', { fromEntry: shared.id, toType: 'contact', toId: contact.id, relation: 'about' });
    expect(l.status).toBe(201);
    expect(l.json.title).toBe('Ana Reyes');
    // Linking to another org's record fails as "not found".
    const bContact = (await call(B, 'POST', '/contacts', { name: 'Other org', email: `o-${randomUUID().slice(0, 6)}@x.test` })).json;
    expect((await call(A, 'POST', '/knowledge/links', { fromEntry: shared.id, toType: 'contact', toId: bContact.id })).status).toBe(404);

    const g = (await call(A, 'GET', '/knowledge/graph')).json;
    expect(g.nodes.length).toBeLessThanOrEqual(150);
    expect(g.edges.length).toBeLessThanOrEqual(400);
    expect(typeof g.truncated).toBe('boolean');
    const ids = new Set(g.nodes.map((n: any) => n.id));
    expect(ids.has(`entry:${shared.id}`)).toBe(true);
    expect(ids.has(`entry:${priv.id}`)).toBe(true);
    for (const e of g.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    // The member's graph never contains the private entry.
    const gm = (await call(M, 'GET', '/knowledge/graph')).json;
    expect(gm.nodes.map((n: any) => n.id)).not.toContain(`entry:${priv.id}`);
    expect(gm.nodes.map((n: any) => n.id)).toContain(`entry:${shared.id}`);
    // Ego view around the contact reaches the entry that is about it.
    const ego = (await call(A, 'GET', `/knowledge/graph?view=ego&focus=contact:${contact.id}`)).json;
    expect(ego.nodes.map((n: any) => n.id)).toEqual(expect.arrayContaining([`contact:${contact.id}`, `entry:${shared.id}`]));
    expect((await call(A, 'GET', '/knowledge/graph?view=ego')).status).toBe(400);
    // The picker finds records of any type.
    const t = (await call(A, 'GET', '/knowledge/targets?q=Ana')).json.items;
    expect(t.map((x: any) => x.type)).toContain('contact');
  });

  it('agent tools: proposals are private to the person in chat; background runs propose shared drafts; search respects visibility', async () => {
    const p = await run(A, 'knowledge.propose', { title: 'Delivery days', body: 'We deliver to Toril on Tuesdays and Fridays.', kind: 'process', category: 'processes' });
    expect(p.ok).toBe(true);
    const id = p.refs[0]!.id;
    const row = await db.withTenant({ orgId: A.org!, userId: A.userId!, runKind: 'interactive' }, (q) => q.one('select visibility, status, source_kind, owner_user_id from memory_records where id=$1', [id]));
    expect(row).toMatchObject({ visibility: 'private', status: 'proposed', source_kind: 'agent_inferred', owner_user_id: A.userId });
    expect((await run(A, 'knowledge.search', { query: 'Toril' })).refs.map((r) => r.id)).toContain(id);
    // In a background run the same person's private proposal is invisible.
    expect((await run(A, 'knowledge.search', { query: 'Toril' }, false)).refs).toEqual([]);
    const bg = await run(A, 'knowledge.propose', { title: 'Weekly stock check', body: 'Count stock every Monday.', kind: 'process' }, false);
    expect(bg.ok).toBe(true);
    const bgRow = await db.withTenant({ orgId: A.org!, userId: M.userId! }, (q) => q.one('select visibility, status from memory_records where id=$1', [bg.refs[0]!.id]));
    expect(bgRow).toMatchObject({ visibility: 'workspace', status: 'proposed' });
    // Confirming a proposal makes it active.
    expect((await call(A, 'POST', `/knowledge/entries/${id}/confirm`)).json.status).toBe('active');
    // knowledge.link marks links as AI-added.
    const contact = (await call(A, 'POST', '/contacts', { name: 'Toril Store', email: `t-${randomUUID().slice(0, 6)}@x.test` })).json;
    expect((await run(A, 'knowledge.link', { entryId: id, toType: 'contact', toId: contact.id })).ok).toBe(true);
    const det = (await call(A, 'GET', `/knowledge/entries/${id}`)).json;
    expect(det.links.find((l: any) => l.targetId === contact.id)).toMatchObject({ aiAdded: true, relation: 'about' });
    // Another org's agent cannot link to it.
    expect((await run(B, 'knowledge.link', { entryId: id, toType: 'contact', toId: contact.id })).ok).toBe(false);
  });

  it('new workspaces allowlist the knowledge and read tools for every agent, and writes only for the right roles', async () => {
    const agents = (await call(A, 'GET', '/agents')).json.items;
    const allow = async (template: string) => (await call(A, 'GET', `/agents/${agents.find((x: any) => x.template === template).id}`)).json.tool_allowlist as string[];
    expect(await allow('research')).toEqual(expect.arrayContaining(['knowledge.search', 'drive.read', 'notion.read', 'github.issues', 'stripe.summary']));
    expect(await allow('research')).not.toContain('drive.create');
    expect(await allow('ceo')).toEqual(expect.arrayContaining(['github.issue.create', 'stripe.invoice.draft', 'notion.create', 'drive.create']));
    expect(await allow('marketing')).not.toContain('stripe.invoice.draft');
    expect(await allow('marketing')).not.toContain('github.issue.create');
  });

  it('Stripe: only restricted keys, verified with Stripe, stored sealed; secret keys are refused', async () => {
    expect((await call(A, 'POST', '/integrations/stripe/key', { key: 'sk_live_abcdefghijklmnop' })).json.code).toBe('STRIPE_SECRET_KEY');
    expect((await call(A, 'POST', '/integrations/stripe/key', { key: 'pk_test_abcdefghijklmnop' })).status).toBe(400);
    expect((await call(M, 'POST', '/integrations/stripe/key', { key: 'rk_test_abcdefghijklmnop' })).status).toBe(403);
    stub([[/GET https:\/\/api\.stripe\.com\/v1\/customers/, () => ({ status: 401, json: { error: { message: 'Invalid API Key provided' } } })]]);
    expect((await call(A, 'POST', '/integrations/stripe/key', { key: 'rk_test_wrongwrongwrong' })).json.code).toBe('STRIPE_KEY_REJECTED');
    stub([
      [/GET https:\/\/api\.stripe\.com\/v1\/customers/, () => ({ json: { data: [] } })],
      [/GET https:\/\/api\.stripe\.com\/v1\/account/, () => ({ json: { settings: { dashboard: { display_name: 'Mara Bakery' } }, email: 'owner@mara.test' } })],
    ]);
    const key = 'rk_test_51abcdefghijklmnopqrstu';
    const ok = await call(A, 'POST', '/integrations/stripe/key', { key });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ provider: 'stripe', accountName: 'Mara Bakery', features: ['stripe'], settings: { mode: 'test' } });
    expect(JSON.stringify(ok.json)).not.toContain(key);
    const raw = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one(`select token_ciphertext from integration_connections where provider='stripe'`));
    expect(String(raw?.token_ciphertext)).not.toContain(key);
    const list = (await call(A, 'GET', '/integrations')).json.providers.find((p: any) => p.id === 'stripe');
    expect(list.connection.accountName).toBe('Mara Bakery');
    expect(JSON.stringify(await call(A, 'GET', '/integrations'))).not.toContain(key);
  });

  it('Stripe tools: summary reads, invoice drafts never finalize or send, and writes are audited', async () => {
    stub([
      [/GET https:\/\/api\.stripe\.com\/v1\/charges/, () => ({ json: { data: [{ amount: 150000, amount_refunded: 0, currency: 'php', status: 'succeeded', paid: true }, { amount: 5000, currency: 'php', status: 'failed', paid: false }], has_more: false } })],
      [/GET https:\/\/api\.stripe\.com\/v1\/invoices/, () => ({ json: { data: [{ amount_remaining: 20000, currency: 'php' }] } })],
      [/GET https:\/\/api\.stripe\.com\/v1\/balance/, () => ({ json: { available: [{ amount: 99900, currency: 'php' }], pending: [] } })],
      [/POST https:\/\/api\.stripe\.com\/v1\/invoices$/, () => ({ json: { id: 'in_123', status: 'draft' } })],
      [/POST https:\/\/api\.stripe\.com\/v1\/invoiceitems/, () => ({ json: { id: 'ii_1' } })],
    ]);
    const s = await run(A, 'stripe.summary', { days: 30 });
    expect(s.ok).toBe(true);
    expect(s.data).toMatchObject({ payments: { PHP: { gross: 1500, count: 1, failed: 1 } }, openInvoices: { count: 1, due: { PHP: 200 } } });
    expect(seen.every((x) => x.headers.authorization?.startsWith('Bearer rk_test_'))).toBe(true);
    const inv = await run(A, 'stripe.invoice.draft', { customerId: 'cus_ABC', currency: 'php', items: [{ description: 'Catering', amount: 2500.5 }] });
    expect(inv.ok).toBe(true);
    const create = seen.find((x) => x.method === 'POST' && x.url.endsWith('/v1/invoices'))!;
    const f = new URLSearchParams(create.body);
    expect(f.get('auto_advance')).toBe('false');
    expect(f.get('collection_method')).toBe('send_invoice');
    expect(create.headers['idempotency-key']).toBeTruthy();
    expect(new URLSearchParams(seen.find((x) => x.url.includes('invoiceitems'))!.body).get('amount')).toBe('250050');
    expect(seen.some((x) => /finalize|send|pay|refund/.test(x.url))).toBe(false);
    const a = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one(`select detail from audit_events where action='stripe.invoice_drafted' order by id desc limit 1`));
    expect(a?.detail).toMatchObject({ customer: 'cus_ABC', total: 2500.5, currency: 'PHP' });
    // Not connected in org B.
    expect((await run(B, 'stripe.summary', { days: 7 })).summary).toMatch(/not connected/);
  });

  it('Notion tools send the pinned API version and create pages under a parent', async () => {
    await connect(A, 'notion', []);
    stub([
      [/POST https:\/\/api\.notion\.com\/v1\/search/, () => ({ json: { results: [{ id: 'p1', url: 'https://notion.so/p1', properties: { Name: { type: 'title', title: [{ plain_text: 'Menu' }] } } }] } })],
      [/GET https:\/\/api\.notion\.com\/v1\/pages\/p1/, () => ({ json: { id: 'p1', url: 'https://notion.so/p1', properties: { title: { type: 'title', title: [{ plain_text: 'Menu' }] } } } })],
      [/GET https:\/\/api\.notion\.com\/v1\/blocks\/p1[^/]*\/children/, () => ({ json: { results: [{ type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Cakes' }] } }, { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Ube roll' }] } }], has_more: false } })],
      [/POST https:\/\/api\.notion\.com\/v1\/pages$/, (x) => ({ json: { id: 'p2', url: 'https://notion.so/p2', echo: JSON.parse(x.body) } })],
    ]);
    const s = await run(A, 'notion.search', { query: 'menu' });
    expect(s.data).toEqual([expect.objectContaining({ id: 'p1', title: 'Menu' })]);
    expect(seen[0]!.headers['notion-version']).toBe('2026-03-11');
    expect(JSON.parse(seen[0]!.body).filter).toEqual({ property: 'object', value: 'page' });
    const r = await run(A, 'notion.read', { pageId: 'p1-0000000000' });
    expect(r.ok).toBe(true);
    expect((r.data as any).text).toBe('# Cakes\n- Ube roll');
    const c = await run(A, 'notion.create', { parentPageId: 'parent-0000000000', title: 'Weekly notes', content: '# Sales\n- 12 orders\n[x] restock' });
    expect(c.ok).toBe(true);
    const post = seen.find((x) => x.method === 'POST' && x.url.endsWith('/v1/pages'))!;
    const body = JSON.parse(post.body);
    expect(body.parent).toEqual({ page_id: 'parent-0000000000' });
    expect(body.children.map((b: any) => b.type)).toEqual(['heading_1', 'bulleted_list_item', 'to_do']);
    const a = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one(`select 1 as x from audit_events where action='notion.page_created' limit 1`));
    expect(a?.x).toBe(1);
  });

  it('GitHub tools list installed repos, read issues and open issues (never code)', async () => {
    await connect(A, 'github', []);
    stub([
      [/GET https:\/\/api\.github\.com\/user\/installations\?/, () => ({ json: { installations: [{ id: 7 }] } })],
      [/GET https:\/\/api\.github\.com\/user\/installations\/7\/repositories/, () => ({ json: { repositories: [{ full_name: 'mara/shop', private: true, open_issues_count: 3, html_url: 'https://github.com/mara/shop' }] } })],
      [/GET https:\/\/api\.github\.com\/search\/issues/, () => ({ json: { items: [{ number: 4, title: 'Fix cart', state: 'open', user: { login: 'mara' }, labels: [] }] } })],
      [/POST https:\/\/api\.github\.com\/repos\/mara\/shop\/issues$/, () => ({ status: 201, json: { number: 5, html_url: 'https://github.com/mara/shop/issues/5', title: 'Add GCash' } })],
    ]);
    expect((await run(A, 'github.repos', {})).data).toEqual([expect.objectContaining({ fullName: 'mara/shop', private: true })]);
    const iss = await run(A, 'github.issues', { repo: 'mara/shop' });
    expect(iss.data).toEqual([expect.objectContaining({ number: 4, title: 'Fix cart' })]);
    expect(decodeURIComponent(seen.find((x) => x.url.includes('/search/issues'))!.url)).toContain('repo:mara/shop state:open');
    expect((await run(A, 'github.issue.create', { repo: 'mara/shop', title: 'Add GCash', body: 'Customers asked.' })).ok).toBe(true);
    expect(seen.every((x) => x.headers['user-agent'] === 'Qline')).toBe(true);
    expect(() => tools.getTool('github.issues')!.schema.parse({ repo: '../../etc' })).toThrow();
    expect(tools.IMPLEMENTED_TOOLS.some((n) => /github\.(push|commit|merge|contents)/.test(n))).toBe(false);
  });

  it('Drive tools need the Drive scope, export Google Docs as text, and save files to the Library', async () => {
    await connect(A, 'google', ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']);
    expect((await run(A, 'drive.search', { query: 'menu' })).summary).toMatch(/without the permission/);
    await connect(A, 'google', ['openid', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']);
    stub([
      [/GET https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/, () => ({ json: { files: [{ id: 'docid1', name: 'Menu 2026', mimeType: 'application/vnd.google-apps.document' }] } })],
      [/GET https:\/\/www\.googleapis\.com\/drive\/v3\/files\/docid1\/export/, () => ({ text: 'Ube roll 450\nPandesal 5' })],
      [/GET https:\/\/www\.googleapis\.com\/drive\/v3\/files\/docid1\?/, () => ({ json: { id: 'docid1', name: 'Menu 2026', mimeType: 'application/vnd.google-apps.document' } })],
      [/POST https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files/, () => ({ json: { id: 'new1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/x' } })],
    ]);
    const s = await run(A, 'drive.search', { query: "o'brien menu" });
    expect(s.data).toEqual([expect.objectContaining({ id: 'docid1', name: 'Menu 2026' })]);
    expect(new URL(seen[0]!.url).searchParams.get('q')).toContain("name contains 'o\\'brien menu'");
    const r = await run(A, 'drive.read', { fileId: 'docid1' });
    expect(r.ok).toBe(true);
    expect((r.data as any).text).toContain('Ube roll 450');
    expect(seen.some((x) => x.url.includes('/export?mimeType=text%2Fplain'))).toBe(true);
    const lib = await run(A, 'drive.save_to_library', { fileId: 'docid1' });
    expect(lib.ok).toBe(true);
    const doc = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.one('select title, body, source_kind, source_ref from documents where id=$1', [lib.refs[0]!.id]));
    expect(doc).toMatchObject({ title: 'Menu 2026', source_kind: 'connector', source_ref: 'drive:docid1' });
    const c = await run(A, 'drive.create', { name: 'Plan', kind: 'doc', content: 'Hello' });
    expect(c.ok).toBe(true);
    const up = seen.find((x) => x.url.includes('/upload/drive/v3/files'))!;
    expect(up.headers['content-type']).toMatch(/^multipart\/related; boundary=/);
    expect(up.body).toContain('"mimeType":"application/vnd.google-apps.document"');
  });

  it('provider failures become plain-language tool failures, never crashes', async () => {
    stub([[/api\.github\.com/, () => ({ status: 401, json: { message: 'Bad credentials' } })]]);
    const r = await run(A, 'github.repos', {});
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Reconnect GitHub/);
    stub([[/api\.notion\.com/, () => ({ status: 404, json: { message: 'Could not find page' } })]]);
    const n = await run(A, 'notion.read', { pageId: 'missing-000000000' });
    expect(n.ok).toBe(false);
    expect(n.summary).toMatch(/could not find/i);
  });
});
