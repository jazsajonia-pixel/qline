/**
 * v1.11 Facebook Pages (docs/27), against a real Postgres as the app role (RLS on). The Graph API is replaced by an
 * in-memory fake behind setFacebookFetch, so these prove Qline's own logic: Page sync and token sealing, the
 * approval gates (content hash, ALWAYS_ASK), publishing and scheduling calls, idempotency, error handling, status
 * reconciliation, cancel, and tenant isolation. They do not prove Meta accepts these calls for a real app; see
 * docs/27 §Verification. Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';
process.env.QLINE_FACEBOOK_CLIENT_ID = 'fb-test-app';
process.env.QLINE_FACEBOOK_CLIENT_SECRET = 'fb-test-secret';

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import('../src/core/db');
let tools: typeof import('../src/agent/tools');
let oauth: typeof import('../src/integrations/oauth');
let fbi: typeof import('../src/integrations/facebook');
let fbm: typeof import('../src/modules/facebook');
let policy: typeof import('@qline/policy');

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

async function setup(name: string): Promise<Who> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.qline.dev`;
  const r = await call(null, 'POST', '/auth/sign-up/email', { email, password: 'correct-horse-battery', name });
  const w: Who = { token: r.json.token };
  w.org = (await call(w, 'POST', '/orgs', { name: `${name} Co` })).json.id;
  w.userId = (await call(w, 'GET', '/me')).json.user.id;
  w.ws = (await db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) => q.one('select id from workspaces where org_id=$1', [w.org])))!.id;
  return w;
}

const asOrg = <T>(w: Who, fn: (q: import('../src/core/db').Q) => Promise<T>) => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);
const ctx = (w: Who) => ({ orgId: w.org!, workspaceId: w.ws!, actor: { kind: 'agent' as const, id: 'test-agent' }, userId: w.userId!, interactive: true });

// ---- Fake Graph API -------------------------------------------------------------------------------
type Sent = { host: string; path: string; method: string; params: Record<string, string>; file?: { name: string; type: string; size: number } };
let sent: Sent[];
let mode: 'ok' | 'expired' | 'rate' | 'network' | 'permission';
let remote: Map<string, { published: boolean }>;

const PAGES = [
  { id: '1110001', name: 'Mara Bakery', category: 'Bakery', tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'], access_token: 'EAAPAGE_TOKEN_MARA' },
  { id: '2220002', name: 'Fan Page', category: 'Community', tasks: ['ANALYZE'], access_token: 'EAAPAGE_TOKEN_FAN' },
];

const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
let seq = 9000;

async function fakeGraph(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(String(input));
  const params: Record<string, string> = Object.fromEntries(u.searchParams);
  let file: Sent['file'];
  if (init?.body instanceof URLSearchParams) Object.assign(params, Object.fromEntries(init.body));
  if (init?.body instanceof FormData) {
    for (const [k, v] of init.body) {
      if (typeof v === 'string') params[k] = v;
      else file = { name: (v as File).name, type: v.type, size: v.size };
    }
  }
  const path = u.pathname.replace(/^\/v27\.0/, '');
  const method = init?.method ?? 'GET';
  sent.push({ host: u.host, path, method, params, file });
  if (mode === 'network' && method !== 'GET') throw new TypeError('fetch failed');
  if (mode === 'expired') return json(400, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } });
  if (mode === 'rate' && method !== 'GET') return json(400, { error: { message: 'Application request limit reached', code: 4 } });
  if (mode === 'permission' && method !== 'GET') return json(403, { error: { message: '(#200) Requires pages_manage_posts permission', code: 200 } });
  if (path === '/oauth/access_token') return json(200, { access_token: 'EAALONG_USER_TOKEN', token_type: 'bearer', expires_in: 5184000 });
  if (path === '/me/permissions' && method === 'GET') return json(200, { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'pages_read_engagement', status: 'granted' }, { permission: 'publish_video', status: 'declined' }] });
  if (path === '/me') return json(200, { id: '42', name: 'Mara Santos' });
  if (path === '/me/accounts') return json(200, { data: PAGES, paging: { cursors: { before: 'a', after: 'b' } } });
  const m = path.match(/^\/(\d+)\/(feed|photos|videos)$/);
  if (m && method === 'POST') {
    const id = `${m[1]}_${++seq}`;
    remote.set(m[2] === 'videos' ? `v${seq}` : id, { published: params.published !== 'false' });
    if (m[2] === 'feed') return json(200, { id });
    if (m[2] === 'photos') return json(200, { id: `p${seq}`, post_id: id });
    return json(200, { id: `v${seq}` });
  }
  const obj = path.slice(1);
  if (method === 'DELETE') {
    remote.delete(obj);
    return json(200, { success: true });
  }
  const r = remote.get(obj);
  if (!r) return json(400, { error: { message: 'Unsupported get request. Object does not exist', code: 100, error_subcode: 33 } });
  if (obj.startsWith('v')) return json(200, { id: obj, published: r.published, permalink_url: `/reel/${obj}`, status: { video_status: 'ready', publishing_phase: { status: r.published ? 'complete' : 'not_started' } } });
  return json(200, { id: obj, is_published: r.published, permalink_url: `https://www.facebook.com/${obj}` });
}

const connect = (w: Who) =>
  asOrg(w, async (q) => {
    const c = await q.one<{ id: string }>(
      `insert into integration_connections (org_id, workspace_id, provider, account_name, scopes, token_ciphertext, status, connected_by)
       values ($1,$2,'facebook','Mara Santos',$3,$4,'ok',$5)
       on conflict (org_id, provider) do update set token_ciphertext=excluded.token_ciphertext, status='ok', status_detail=null returning id`,
      [w.org, w.ws, ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'], oauth.sealTokens(w.org!, 'facebook', { access_token: 'EAALONG_USER_TOKEN' }), w.userId],
    );
    return c!.id;
  });

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);

async function upload(w: Who, name: string, bytes: Uint8Array, type: string) {
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type }), name);
  const res = await app.fetch(new Request('http://localhost/v1/facebook/media', { method: 'POST', headers: { authorization: `Bearer ${w.token}`, 'x-qline-org': w.org! }, body: form }));
  return { status: res.status, json: (await res.json()) as any };
}

/** Preview, then post exactly what was previewed. */
async function post(w: Who, draft: Record<string, unknown>, key = randomUUID()) {
  const pv = await call(w, 'POST', '/facebook/posts/preview', draft);
  if (pv.status !== 200) return pv;
  return call(w, 'POST', '/facebook/posts', { ...draft, confirm: true, contentHash: pv.json.contentHash, requestKey: key });
}

d('v1.11 Facebook Pages (integration)', () => {
  let A: Who;
  let B: Who;
  let pageRef: string;
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    oauth = await import('../src/integrations/oauth');
    fbi = await import('../src/integrations/facebook');
    fbm = await import('../src/modules/facebook');
    policy = await import('@qline/policy');
    fbi.setFacebookFetch(fakeGraph as typeof fetch);
    A = await setup('Mara');
    B = await setup('Tess');
  });
  beforeEach(() => {
    sent = [];
    mode = 'ok';
    remote ??= new Map();
  });
  afterAll(async () => {
    fbi.setFacebookFetch(null);
    await db.closePool();
  });

  it('lists Facebook as an OAuth provider and builds a Pages-only login URL', async () => {
    const r = await call(A, 'GET', '/integrations');
    const fb = r.json.providers.find((p: any) => p.id === 'facebook');
    expect(fb).toMatchObject({ name: 'Facebook', auth: 'oauth', registered: true });
    expect(fb.features.map((f: any) => f.id)).toEqual(['facebook_pages', 'facebook_video']);
    expect(r.json.other.some((x: any) => /instagram/i.test(x.id) && x.status === 'planned')).toBe(true);
    const c = await call(A, 'POST', '/integrations/facebook/connect', {});
    const u = new URL(c.json.url);
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v27.0/dialog/oauth');
    expect(u.searchParams.get('scope')!.split(' ').sort()).toEqual(['pages_manage_posts', 'pages_read_engagement', 'pages_show_list', 'publish_video']);
    expect(u.searchParams.get('scope')).not.toMatch(/instagram|publish_to_groups|user_posts/);
    expect(u.searchParams.get('auth_type')).toBe('rerequest');
    expect(u.searchParams.get('code_challenge')).toBeNull();
  });

  it('the login callback swaps for a long-lived token, records granted permissions and syncs Pages with sealed tokens', async () => {
    const c = await call(A, 'POST', '/integrations/facebook/connect', {});
    const state = new URL(c.json.url).searchParams.get('state')!;
    const cb = await app.fetch(new Request(`http://localhost/v1/integrations/facebook/callback?state=${state}&code=AUTH_CODE`));
    expect(cb.status).toBe(200);
    expect(sent.find((s) => s.path === '/oauth/access_token' && s.params.grant_type === 'fb_exchange_token')).toBeTruthy();
    // appsecret_proof on every Graph call made with a token
    expect(sent.filter((s) => s.path !== '/oauth/access_token' || s.params.grant_type === 'fb_exchange_token').every((s) => /^[0-9a-f]{64}$/.test(s.params.appsecret_proof ?? ''))).toBe(true);
    const conn = await asOrg(A, (q) => q.one(`select scopes, account_name, token_ciphertext from integration_connections where provider='facebook'`));
    expect(conn.account_name).toBe('Mara Santos');
    expect(conn.scopes.sort()).toEqual(['pages_manage_posts', 'pages_read_engagement', 'pages_show_list']); // publish_video was declined
    expect(conn.token_ciphertext).not.toContain('EAALONG');
    const pages = await asOrg(A, (q) => q.many(`select page_id, name, status, token_ciphertext from facebook_pages order by page_id`));
    expect(pages.map((p: any) => [p.page_id, p.status])).toEqual([['1110001', 'ok'], ['2220002', 'no_access']]);
    expect(pages[0].token_ciphertext).not.toContain('EAAPAGE');
    expect(pages[1].token_ciphertext).toBeNull();
    const list = await call(A, 'GET', '/facebook/pages');
    expect(list.json.connection).toMatchObject({ status: 'ok', canPostVideo: false });
    expect(list.json.pages.map((p: any) => [p.name, p.canPost])).toEqual([['Fan Page', false], ['Mara Bakery', true]]);
    expect(JSON.stringify(list.json)).not.toContain('EAA');
    pageRef = list.json.pages.find((p: any) => p.canPost).id;
    const integ = await call(A, 'GET', '/integrations');
    expect(integ.json.providers.find((p: any) => p.id === 'facebook').connection.features).toEqual(['facebook_pages']);
  });

  it('a person posts only with confirm and the hash of the exact preview; a changed post is refused', async () => {
    const draft = { pageRef, kind: 'text', message: 'Fresh pandesal at 6 AM!' };
    const pv = await call(A, 'POST', '/facebook/posts/preview', draft);
    expect(pv.status).toBe(200);
    expect(pv.json.preview.title).toBe('Publish a Facebook post on Mara Bakery');
    expect(pv.json.preview.lines).toContain('Text: Fresh pandesal at 6 AM!');
    expect(sent).toEqual([]); // preview never calls Facebook
    expect((await call(A, 'POST', '/facebook/posts', { ...draft, contentHash: pv.json.contentHash, requestKey: randomUUID() })).status).toBe(400); // no confirm
    const changed = await call(A, 'POST', '/facebook/posts', { ...draft, message: 'Fresh pandesal at 7 AM!', confirm: true, contentHash: pv.json.contentHash, requestKey: randomUUID() });
    expect(changed.status).toBe(409);
    expect(changed.json.code ?? changed.json.error?.code).toBe('FACEBOOK_POST_CHANGED');
    expect(sent).toEqual([]);
    const key = randomUUID();
    const ok = await call(A, 'POST', '/facebook/posts', { ...draft, confirm: true, contentHash: pv.json.contentHash, requestKey: key });
    expect(ok.status).toBe(201);
    expect(ok.json.post).toMatchObject({ status: 'published', kind: 'text', source: 'user', pageName: 'Mara Bakery' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'POST', path: '/1110001/feed', params: { message: 'Fresh pandesal at 6 AM!', access_token: 'EAAPAGE_TOKEN_MARA' } });
    // A double tap with the same request key returns the same post and sends nothing.
    const again = await call(A, 'POST', '/facebook/posts', { ...draft, confirm: true, contentHash: pv.json.contentHash, requestKey: key });
    expect(again.json.post.id).toBe(ok.json.post.id);
    expect(sent).toHaveLength(1);
    const audit = await asOrg(A, (q) => q.many(`select action from audit_events where target_ref=$1 order by id`, [`facebook_post:${ok.json.post.id}`]));
    expect(audit.map((a: any) => a.action)).toEqual(['facebook.post_requested', 'facebook.post_published']);
  });

  it('refuses Pages the person cannot post to, bad links and schedule times outside Facebook\'s window', async () => {
    const fan = (await call(A, 'GET', '/facebook/pages')).json.pages.find((p: any) => !p.canPost).id;
    expect((await call(A, 'POST', '/facebook/posts/preview', { pageRef: fan, kind: 'text', message: 'hi' })).json.detail ?? '').toMatch(/cannot create posts on Fan Page/);
    expect((await call(A, 'POST', '/facebook/posts/preview', { pageRef, kind: 'link', message: 'x', link: 'javascript:alert(1)' })).status).toBe(400);
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const far = new Date(Date.now() + 40 * 24 * 3600_000).toISOString();
    expect((await call(A, 'POST', '/facebook/posts/preview', { pageRef, kind: 'text', message: 'x', scheduleAt: soon })).json.detail ?? '').toMatch(/at least 10 minutes/);
    expect((await call(A, 'POST', '/facebook/posts/preview', { pageRef, kind: 'text', message: 'x', scheduleAt: far })).json.detail ?? '').toMatch(/30 days/);
    expect((await call(A, 'POST', '/facebook/posts/preview', { pageRef, kind: 'photo', message: 'x' })).json.detail ?? '').toMatch(/Choose a photo/);
    expect(sent).toEqual([]);
  });

  it('schedules a link post, reconciles it when it goes live, and notifies the person', async () => {
    const at = new Date(Date.now() + 2 * 3600_000);
    const r = await post(A, { pageRef, kind: 'link', message: 'Our new menu', link: 'https://example.com/menu', scheduleAt: at.toISOString() });
    expect(r.status).toBe(201);
    expect(r.json.post.status).toBe('scheduled');
    expect(sent[0].params).toMatchObject({ link: 'https://example.com/menu', published: 'false', scheduled_publish_time: String(Math.floor(at.getTime() / 1000)) });
    const job = await asOrg(A, (q) => q.one(`select run_at from jobs where kind='facebook.reconcile' and payload->>'postId'=$1`, [r.json.post.id]));
    expect(new Date(job.run_at).getTime()).toBeGreaterThan(at.getTime());
    // Still scheduled on Facebook: nothing changes.
    expect((await fbm.refreshPost(A.org!, r.json.post.id)).status).toBe('scheduled');
    // Facebook publishes it at the time.
    const obj = (await asOrg(A, (q) => q.one(`select fb_object_id from facebook_posts where id=$1`, [r.json.post.id]))).fb_object_id;
    remote.get(obj)!.published = true;
    const done = await fbm.refreshPost(A.org!, r.json.post.id);
    expect(done.status).toBe('published');
    expect(done.permalink).toMatch(/^https:\/\/www\.facebook\.com\//);
    const n = await asOrg(A, (q) => q.one(`select title from notifications where user_id=$1 and category='facebook' order by created_at desc limit 1`, [A.userId]));
    expect(n.title).toBe('Posted on Mara Bakery');
  });

  it('cancels a scheduled post on Facebook and keeps it as cancelled; published posts cannot be cancelled', async () => {
    const r = await post(A, { pageRef, kind: 'text', message: 'Holiday hours', scheduleAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
    sent = [];
    expect((await call(A, 'POST', `/facebook/posts/${r.json.post.id}/cancel`, {})).status).toBe(400); // needs confirm
    const c = await call(A, 'POST', `/facebook/posts/${r.json.post.id}/cancel`, { confirm: true });
    expect(c.json.post.status).toBe('cancelled');
    expect(sent.map((s) => s.method)).toEqual(['DELETE']);
    const pub = await post(A, { pageRef, kind: 'text', message: 'Live now' });
    expect((await call(A, 'POST', `/facebook/posts/${pub.json.post.id}/cancel`, { confirm: true })).status).toBe(409);
    // History is kept: the app role cannot delete posts.
    await expect(asOrg(A, (q) => q.exec(`delete from facebook_posts where id=$1`, [r.json.post.id]))).rejects.toThrow(/permission denied/);
  });

  it('uploads a photo and a video privately and sends the bytes to Facebook as multipart', async () => {
    const ph = await upload(A, 'cake.png', PNG, 'image/png');
    expect(ph.status).toBe(201);
    expect(ph.json.kind).toBe('photo');
    const webp = await upload(A, 'x.mp4', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'video/mp4');
    expect(webp.status).toBe(400);
    const r = await post(A, { pageRef, kind: 'photo', message: 'Ube cake', fileId: ph.json.id });
    expect(r.json.post.status).toBe('published');
    expect(sent[0]).toMatchObject({ path: '/1110001/photos', params: { caption: 'Ube cake' }, file: { name: 'cake.png', type: 'image/png', size: PNG.length } });
    const vid = await upload(A, 'clip.mp4', MP4, 'video/mp4');
    expect(vid.json.kind).toBe('video');
    sent = [];
    const v = await post(A, { pageRef, kind: 'video', message: 'Behind the scenes', title: 'Baking day', fileId: vid.json.id });
    expect(v.json.post.status).toBe('processing');
    expect(sent[0]).toMatchObject({ host: 'graph-video.facebook.com', path: '/1110001/videos', params: { description: 'Behind the scenes', title: 'Baking day' }, file: { type: 'video/mp4' } });
    expect((await fbm.refreshPost(A.org!, v.json.post.id)).status).toBe('published');
    // Another organization cannot use this file.
    await connect(B);
    await asOrg(B, async (q) => {
      const conn = await q.one<{ id: string }>(`select id from integration_connections where provider='facebook'`);
      await fbm.syncPages(q, B.org!, conn!.id, 'EAALONG_USER_TOKEN', 'fb-test-secret');
    });
    const bPage = (await call(B, 'GET', '/facebook/pages')).json.pages.find((p: any) => p.canPost).id;
    expect((await call(B, 'POST', '/facebook/posts/preview', { pageRef: bPage, kind: 'photo', message: 'x', fileId: ph.json.id })).json.detail ?? '').toMatch(/not found/);
  });

  it('maps Facebook errors: expired login marks the connection, refusals fail, no answer is "unknown" and never retried', async () => {
    mode = 'rate';
    let r = await post(A, { pageRef, kind: 'text', message: 'rate test' });
    expect(r.status).toBe(422);
    expect(r.json.post).toMatchObject({ status: 'failed', errorKind: 'rate_limit' });
    expect(r.json.post.error).toMatch(/limiting requests/);
    mode = 'permission';
    r = await post(A, { pageRef, kind: 'text', message: 'perm test' });
    expect(r.json.post).toMatchObject({ status: 'failed', errorKind: 'permission' });
    mode = 'network';
    r = await post(A, { pageRef, kind: 'text', message: 'network test' });
    expect(r.json.post.status).toBe('unknown');
    expect(r.json.post.error).toMatch(/Outcome unknown/);
    expect(await asOrg(A, (q) => q.one(`select count(*)::int as n from jobs where kind='facebook.reconcile' and payload->>'postId'=$1`, [r.json.post.id]))).toEqual({ n: 0 });
    mode = 'expired';
    r = await post(A, { pageRef, kind: 'text', message: 'expired test' });
    expect(r.json.post).toMatchObject({ status: 'failed', errorKind: 'reconnect' });
    expect((await asOrg(A, (q) => q.one(`select status from integration_connections where provider='facebook'`))).status).toBe('expired');
    expect(JSON.stringify(r.json)).not.toContain('EAA');
    await connect(A);
  });

  it('the AI can only post through Approvals: ALWAYS_ASK even on full autopilot, pinned to the content hash', async () => {
    const decide = policy.decideTool({ tool: 'facebook.post', allowlist: ['facebook.post'], userRole: 'owner', autonomy: 'full', relaxed: ['facebook.post'] });
    expect(decide.decision).toBe('require_approval');
    expect(policy.ALWAYS_ASK.has('facebook.post')).toBe(true);
    expect(policy.EXTERNAL_WRITE_TOOLS.has('facebook.post')).toBe(true);
    expect(policy.TOOL_POLICIES['facebook.post'].templates).toEqual(['ceo', 'marketing']);
    const t = tools.getTool('facebook.post')!;
    const args = t.schema.parse({ page: 'Mara Bakery', message: 'AI written post' });
    // Without staging (or with a forged pin) nothing is posted.
    expect((await asOrg(A, (q) => t.execute(q, ctx(A), args))).ok).toBe(false);
    expect((await asOrg(A, (q) => t.execute(q, ctx(A), { ...(args as object), _pinned: { hash: 'f'.repeat(64), pageRef } } as any))).summary).toMatch(/changed after it was approved/);
    expect(sent).toEqual([]);
    const st = await asOrg(A, (q) => t.stage!(q, ctx(A), args));
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.preview.title).toBe('Publish a Facebook post on Mara Bakery');
    const done = await asOrg(A, (q) => t.execute(q, ctx(A), st.args));
    expect(done).toMatchObject({ ok: true, summary: 'Posted on Mara Bakery' });
    const row = await asOrg(A, (q) => q.one(`select source, notify_user from facebook_posts where message='AI written post'`));
    expect(row).toEqual({ source: 'agent', notify_user: A.userId });
    const pages = await asOrg(A, (q) => tools.getTool('facebook.pages')!.execute(q, ctx(A), {}));
    expect(JSON.stringify(pages)).not.toContain('EAA');
  });

  it('tenant isolation: another organization sees none of these Pages or posts', async () => {
    const mine = await asOrg(A, (q) => q.one(`select id from facebook_posts limit 1`));
    const theirs = await call(B, 'GET', `/facebook/posts/${mine.id}`);
    expect(theirs.status).toBe(404);
    const bList = await call(B, 'GET', '/facebook/posts');
    expect(bList.json.posts.some((p: any) => p.id === mine.id)).toBe(false);
    expect((await call(B, 'POST', '/facebook/posts/preview', { pageRef, kind: 'text', message: 'x' })).json.detail ?? '').toMatch(/not connected/);
  });

  it('disconnecting forgets every Page token and keeps post history', async () => {
    const before = await asOrg(A, (q) => q.one(`select count(*)::int as n from facebook_posts`));
    const r = await call(A, 'DELETE', '/integrations/facebook');
    expect(r.status).toBe(200);
    expect(sent.some((s) => s.method === 'DELETE' && s.path === '/me/permissions')).toBe(true);
    const pages = await asOrg(A, (q) => q.many(`select status, token_ciphertext from facebook_pages`));
    expect(pages.every((p: any) => p.status === 'removed' && p.token_ciphertext === null)).toBe(true);
    expect(await asOrg(A, (q) => q.one(`select count(*)::int as n from facebook_posts`))).toEqual(before);
  });
});
