/**
 * Content handoff run 2 / Slice 1 (docs/22 ADR-C1): Drive folder mapping, boundary validation and asset indexing,
 * against a real Postgres as the app role (RLS on). Google Drive is a fake in-memory tree behind a fetch stub;
 * nothing leaves the machine. Needs QLINE_TEST_ENV; skipped otherwise.
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
let oauth: typeof import('../src/integrations/oauth');

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = who ? { authorization: `Bearer ${who.token}`, ...(who.org ? { 'x-qline-org': who.org } : {}) } : {};
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

const GD = 'https://www.googleapis.com/auth/';
const connect = (w: Who, scopes = [GD + 'drive.readonly', GD + 'drive.file'], email = 'jazz@example.com') =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) =>
    q.exec(
      `insert into integration_connections (org_id, workspace_id, provider, account_email, account_name, scopes, token_ciphertext, status, connected_by) values ($1,$2,'google',$3,'Test',$4,$5,'ok',$6)
       on conflict (org_id, provider) do update set scopes=excluded.scopes, account_email=excluded.account_email, token_ciphertext=excluded.token_ciphertext, status='ok'`,
      [w.org, w.ws, email, scopes, oauth.sealTokens(w.org!, 'google', { access_token: 'tok-google' }), w.userId],
    ),
  );

// ---- Fake Drive -------------------------------------------------------------------------------
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
type Node = { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean; driveId?: string; size?: string; md5Checksum?: string; version?: string; videoMediaMetadata?: any };
let tree: Map<string, Node>;
let failures: Map<string, number>; // id -> HTTP status for files.get and for listing that folder
let seen: { method: string; url: string }[] = [];
const PAGE = 2; // the fake pages by 2 regardless of pageSize, to exercise pagination
const realFetch = globalThis.fetch;

function baseTree() {
  const n = (id: string, mimeType: string, parent: string | null, extra: Partial<Node> = {}): Node => ({ id, name: id, mimeType, parents: parent ? [parent] : undefined, ...extra });
  const nodes = [
    n('ROOT', FOLDER, 'myDrive'),
    n('myDrive', FOLDER, null),
    n('ASSETS', FOLDER, 'ROOT'),
    n('a1.mp4', 'video/mp4', 'ASSETS', { size: '1048576', md5Checksum: 'abc123', version: '7', videoMediaMetadata: { width: 1080, height: 1920, durationMillis: '15000' } }),
    n('a2.png', 'image/png', 'ASSETS'),
    n('a3.txt', 'text/plain', 'ASSETS'),
    n('a4.jpg', 'image/jpeg', 'ASSETS'),
    n('a5.jpg', 'image/jpeg', 'ASSETS'),
    n('SUB', FOLDER, 'ASSETS'),
    n('s1.mov', 'video/quicktime', 'SUB'),
    n('sc-link', SHORTCUT, 'ASSETS'),
    n('SHORTCUT_TARGET', FOLDER, 'OTHER_ROOT'),
    n('QA', FOLDER, 'ROOT'),
    n('out.mp4', 'video/mp4', 'QA'),
    n('NESTED', FOLDER, 'ROOT'),
    n('REPORTS', FOLDER, 'NESTED'),
    n('OTHER_ROOT', FOLDER, 'myDrive'),
    n('OUTSIDE', FOLDER, 'OTHER_ROOT'),
    n('o1.txt', 'text/plain', 'OUTSIDE'),
    n('TRASHED', FOLDER, 'ROOT', { trashed: true }),
    n('UNDER_TRASHED', FOLDER, 'TRASHED'),
    n('PLAIN_FILE', 'application/pdf', 'ROOT'),
    n('FOLDER_SHORTCUT', SHORTCUT, 'ROOT'),
    n('SHARED', FOLDER, 'ROOT', { driveId: 'shared-drive-1' }),
    n('NO_ACCESS', FOLDER, 'ROOT'),
  ];
  tree = new Map(nodes.map((x) => [x.id, x]));
  failures = new Map([['NO_ACCESS', 403]]);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function installDrive() {
  seen = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    seen.push({ method, url: url.toString() });
    if (url.host !== 'www.googleapis.com') return json(599, { error: { message: `unstubbed ${url}` } });
    const err = (id: string) => (failures.has(id) ? json(failures.get(id)!, { error: { message: `fake ${failures.get(id)}` } }) : null);
    const one = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (method === 'GET' && one) {
      const id = decodeURIComponent(one[1]!);
      const e = err(id);
      if (e) return e;
      const f = tree.get(id);
      return f ? json(200, f) : json(404, { error: { message: 'File not found' } });
    }
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const parent = url.searchParams.get('q')?.match(/^'([^']+)' in parents and trashed = false$/)?.[1];
      if (!parent) return json(400, { error: { message: 'unexpected query' } });
      const e = err(parent);
      if (e) return e;
      const kids = [...tree.values()].filter((f) => f.parents?.includes(parent) && !f.trashed);
      const at = Number(url.searchParams.get('pageToken') ?? 0);
      const page = kids.slice(at, at + PAGE);
      return json(200, { files: page, ...(at + PAGE < kids.length ? { nextPageToken: String(at + PAGE) } : {}) });
    }
    return json(599, { error: { message: `unstubbed ${method} ${url}` } });
  }) as typeof fetch;
}
/** How many list calls asked for the children of a folder. */
const listed = (id: string) => seen.filter((s) => new URL(s.url).searchParams.get('q') === `'${id}' in parents and trashed = false`).length;
const noWrites = () => {
  expect(seen.length).toBeGreaterThan(0);
  for (const s of seen) {
    expect(s.method).toBe('GET');
    expect(s.url).not.toContain('/upload/');
  }
};

const GOOD = { rootFolderId: 'ROOT', roles: { assets: ['ASSETS'], ready_for_qa: 'QA', external_reports: 'REPORTS' } };

d('content handoff run 2: Drive folder mapping and asset indexing (integration)', () => {
  let A: Who; // owner of org A
  let M: Who; // member of org A
  let B: Who; // another organization
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    oauth = await import('../src/integrations/oauth');
    A = await setup('Jazz');
    B = await setup('Other');
    M = await signUp('Mem');
    const inv = await call(A, 'POST', '/invitations', { role: 'member' });
    expect((await call({ token: M.token }, 'POST', '/invitations/accept', { code: inv.json.code })).status).toBe(200);
    M.org = A.org;
    await connect(A);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('starts unconfigured; mapping input is strict and permission-checked', async () => {
    expect((await call(A, 'GET', '/content/drive-config')).json.status).toBe('unconfigured');
    expect((await call(A, 'POST', '/content/sync')).json.code).toBe('NOT_CONFIGURED');
    // the root cannot also be a role folder, and a folder cannot have two roles
    expect((await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: ['ROOT'], ready_for_qa: 'QA' } })).status).toBe(400);
    expect((await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: ['QA'], ready_for_qa: 'QA' } })).status).toBe(400);
    // required roles, unknown roles, bad ids
    expect((await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: ['ASSETS'] } })).status).toBe(400);
    expect((await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { ...GOOD.roles, publish: 'X' } })).status).toBe(400);
    expect((await call(A, 'PUT', '/content/drive-config', { rootFolderId: "ROOT' or 'x", roles: GOOD.roles })).status).toBe(400);
    // members can read but not change the mapping or sync
    expect((await call(M, 'PUT', '/content/drive-config', GOOD)).status).toBe(403);
    expect((await call(M, 'POST', '/content/sync')).status).toBe(403);
    expect((await call(M, 'GET', '/content/drive-config')).status).toBe(200);
  });

  it('refuses to validate without the drive.readonly scope', async () => {
    baseTree();
    installDrive();
    expect((await call(A, 'PUT', '/content/drive-config', GOOD)).json.status).toBe('needs_revalidation');
    await connect(A, [GD + 'drive.file']);
    expect((await call(A, 'POST', '/content/drive-config/validate')).json.code).toBe('SCOPE_MISSING');
    await connect(A);
  });

  it('rejects folders outside the root, trashed, shortcuts, non-folders, other drives and no access', async () => {
    baseTree();
    installDrive();
    const cases: [string, string][] = [
      ['OUTSIDE', 'outside_root'],
      ['TRASHED', 'trashed'],
      ['UNDER_TRASHED', 'trashed_parent'],
      ['FOLDER_SHORTCUT', 'shortcut'],
      ['PLAIN_FILE', 'not_a_folder'],
      ['SHARED', 'different_drive'],
      ['NO_ACCESS', 'no_access'],
      ['MISSING_ID', 'no_access'],
    ];
    for (const [id, reason] of cases) {
      await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: [id], ready_for_qa: 'QA' } });
      const v = await call(A, 'POST', '/content/drive-config/validate');
      expect(v.status, JSON.stringify(v.json)).toBe(200);
      expect(v.json.status).toBe('invalid');
      expect(v.json.validation.folders.find((f: any) => f.role === 'assets')).toMatchObject({ folderId: id, ok: false, reason });
      // an invalid mapping can never be synced
      expect((await call(A, 'POST', '/content/sync')).json.code).toBe('NOT_VALIDATED');
    }
    // a root that is not a folder
    await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'PLAIN_FILE', roles: { assets: ['ASSETS'], ready_for_qa: 'QA' } });
    const v = await call(A, 'POST', '/content/drive-config/validate');
    expect(v.json.validation.root).toMatchObject({ ok: false, reason: 'not_a_folder' });
    noWrites();
  });

  it('stops walking parents after 20 levels', async () => {
    baseTree();
    let parent = 'OTHER_ROOT';
    for (let i = 0; i < 25; i++) {
      tree.set(`L${i}`, { id: `L${i}`, name: `L${i}`, mimeType: FOLDER, parents: [parent] });
      parent = `L${i}`;
    }
    installDrive();
    await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: ['L24'], ready_for_qa: 'QA' } });
    const v = await call(A, 'POST', '/content/drive-config/validate');
    expect(v.json.validation.folders[0]).toMatchObject({ ok: false, reason: 'too_deep' });
    expect(seen.filter((s) => s.url.includes('/files/L')).length).toBeLessThanOrEqual(21);
  });

  it('validates a good mapping (nested role folder too) and indexes every page recursively, skipping shortcuts', async () => {
    baseTree();
    installDrive();
    await call(A, 'PUT', '/content/drive-config', GOOD);
    const v = await call(A, 'POST', '/content/drive-config/validate');
    expect(v.json.status).toBe('valid');
    expect(v.json.validation.folders.every((f: any) => f.ok)).toBe(true);
    const s = await call(A, 'POST', '/content/sync');
    expect(s.status).toBe(200);
    expect(s.json.sync).toMatchObject({ indexed: 7, skippedShortcuts: 1, truncated: null, removed: 0 });
    expect(s.json.lastSuccessAt).toBeTruthy();
    expect(s.json.lastError).toBeNull();
    // ASSETS has 7 children → 4 pages of 2
    expect(listed('ASSETS')).toBe(4);
    const assets = (await call(A, 'GET', '/content/assets?role=assets')).json.items;
    expect(assets.map((x: any) => x.driveFileId).sort()).toEqual(['a1.mp4', 'a2.png', 'a3.txt', 'a4.jpg', 'a5.jpg', 's1.mov']);
    expect(assets.find((x: any) => x.driveFileId === 'a1.mp4')).toMatchObject({ md5: 'abc123', width: 1080, height: 1920, durationMs: '15000', sizeBytes: '1048576', version: '7' });
    expect(assets.find((x: any) => x.driveFileId === 's1.mov')).toMatchObject({ parentId: 'SUB', depth: 1 });
    const sc = (await call(A, 'GET', '/content/assets?state=skipped_shortcut')).json.items;
    expect(sc.map((x: any) => x.driveFileId)).toEqual(['sc-link']);
    // shortcut targets and anything outside the mapped folders are never listed
    expect(seen.some((x) => x.url.includes('SHORTCUT_TARGET') || x.url.includes('OUTSIDE'))).toBe(false);
    expect((await call(A, 'GET', '/content/assets?role=ready_for_qa')).json.items.map((x: any) => x.driveFileId)).toEqual(['out.mp4']);
    expect((await call(A, 'GET', '/content/assets?q=a1')).json.items).toHaveLength(1);
    // a member can read the index
    expect((await call(M, 'GET', '/content/assets')).json.items.length).toBe(7);
    noWrites();
  });

  it('re-sync is idempotent and marks files that disappeared as removed', async () => {
    installDrive();
    expect((await call(A, 'POST', '/content/sync')).json.sync).toMatchObject({ indexed: 7, removed: 0 });
    tree.delete('a3.txt');
    expect((await call(A, 'POST', '/content/sync')).json.sync).toMatchObject({ indexed: 6, removed: 1 });
    expect((await call(A, 'GET', '/content/assets?state=removed')).json.items.map((x: any) => x.driveFileId)).toEqual(['a3.txt']);
    const rows = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.many('select drive_file_id from content_assets where workspace_id=$1', [A.ws]));
    expect(new Set(rows.map((r: any) => r.drive_file_id)).size).toBe(rows.length);
    noWrites();
  });

  it('401, 403, 404 and 429 are explicit and recorded; nothing is removed on a failed sync', async () => {
    installDrive();
    failures.set('ASSETS', 404);
    const lost = await call(A, 'POST', '/content/sync');
    expect(lost.status).toBe(409);
    expect(lost.json.code).toBe('FOLDER_ACCESS_LOST');
    let cfg = (await call(A, 'GET', '/content/drive-config')).json;
    expect(cfg.status).toBe('needs_revalidation');
    expect(cfg.lastError).toMatch(/Folder access lost/);
    expect((await call(A, 'GET', '/content/assets')).json.items.length).toBe(6);
    failures.delete('ASSETS');
    expect((await call(A, 'POST', '/content/drive-config/validate')).json.status).toBe('valid');

    failures.set('SUB', 403); // a folder inside a mapped folder
    expect((await call(A, 'POST', '/content/sync')).json.code).toBe('FOLDER_ACCESS_LOST');
    expect((await call(A, 'GET', '/content/drive-config')).json.status).toBe('valid');
    failures.delete('SUB');

    failures.set('QA', 401);
    const re = await call(A, 'POST', '/content/sync');
    expect(re.status).toBe(409);
    expect(re.json.code).toBe('RECONNECT_REQUIRED');
    failures.set('QA', 429);
    const busy = await call(A, 'POST', '/content/sync');
    expect(busy.status).toBe(503);
    cfg = (await call(A, 'GET', '/content/drive-config')).json;
    expect(cfg.lastError).toMatch(/Try again/);
    failures.delete('QA');
    expect((await call(A, 'GET', '/content/assets')).json.items.length).toBe(6);
    const ok = await call(A, 'POST', '/content/sync');
    expect(ok.status).toBe(200);
    expect(ok.json.lastError).toBeNull();
    noWrites();
  });

  it('a different Google account needs the mapping checked again', async () => {
    installDrive();
    await connect(A, undefined, 'someone-else@example.com');
    expect((await call(A, 'POST', '/content/sync')).json.code).toBe('NEEDS_REVALIDATION');
    expect((await call(A, 'GET', '/content/drive-config')).json.status).toBe('needs_revalidation');
    await connect(A);
    expect((await call(A, 'POST', '/content/drive-config/validate')).json.status).toBe('valid');
  });

  it('stops at depth 8 without concluding that deeper files are gone', async () => {
    installDrive();
    let parent = 'SUB';
    for (let i = 0; i < 9; i++) {
      tree.set(`D${i}`, { id: `D${i}`, name: `D${i}`, mimeType: FOLDER, parents: [parent] });
      parent = `D${i}`;
    }
    tree.set('deep.mp4', { id: 'deep.mp4', name: 'deep.mp4', mimeType: 'video/mp4', parents: [parent] });
    tree.delete('a2.png');
    const s = await call(A, 'POST', '/content/sync');
    expect(s.json.sync).toMatchObject({ truncated: 'depth_limit', removed: 0 });
    expect(s.json.lastError).toMatch(/deeper than 8/);
    const ids = (await call(A, 'GET', '/content/assets?limit=100')).json.items.map((x: any) => x.driveFileId);
    expect(ids).not.toContain('deep.mp4');
    expect(ids).toContain('a2.png'); // not removed: the listing was incomplete
    expect(listed('D6')).toBe(1); // depth 8 below the mapped folder is still listed
    expect(listed('D7')).toBe(0); // depth 9 is not
  });

  it('changing the mapping retires the old index until validated and synced again', async () => {
    installDrive();
    await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: ['SUB'], ready_for_qa: 'QA' } });
    expect((await call(A, 'GET', '/content/assets')).json.items).toEqual([]);
    expect((await call(A, 'POST', '/content/sync')).json.code).toBe('NOT_VALIDATED');
    // saving the same mapping again keeps its state
    await call(A, 'POST', '/content/drive-config/validate');
    expect((await call(A, 'PUT', '/content/drive-config', { rootFolderId: 'ROOT', roles: { assets: ['SUB'], ready_for_qa: 'QA' } })).json.status).toBe('valid');
  });

  it('another organization sees nothing and cannot sync', async () => {
    expect((await call(B, 'GET', '/content/drive-config')).json.status).toBe('unconfigured');
    expect((await call(B, 'GET', '/content/assets?state=all')).json.items).toEqual([]);
    expect((await call(B, 'POST', '/content/sync')).json.code).toBe('NOT_CONFIGURED');
    const leaked = await db.withTenant({ orgId: B.org!, userId: B.userId! }, (q) => q.many('select 1 from content_assets union all select 1 from content_drive_config'));
    expect(leaked).toEqual([]);
  });

  it('every change is audited', async () => {
    const rows = await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.many(`select action from audit_events where action like 'content.%'`));
    const actions = new Set(rows.map((r: any) => r.action));
    expect(actions).toEqual(new Set(['content.drive_config.updated', 'content.drive_config.validated', 'content.drive_synced']));
  });
});
