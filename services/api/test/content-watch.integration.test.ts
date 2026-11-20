/**
 * Content handoff run 5 / Slice 3 (docs/22 ADR-C4): Drive change tracking, push channels, the public webhook, the
 * 10-minute reconciliation, sweeps, retries with backoff and the per-workspace sync lease.
 * Real Postgres as the app role (RLS on). Google Drive is a fake in-memory tree with a changes feed behind a fetch stub;
 * nothing leaves the machine. The only non-GET calls allowed are changes.watch and channels.stop.
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const envFile = process.env.QLINE_TEST_ENV;
if (envFile) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.QLINE_RUNTIME_KICK = '0';
delete process.env.QLINE_DRIVE_WEBHOOK_URL;

const d = envFile ? describe : describe.skip;

type Who = { token: string; org?: string; userId?: string; ws?: string };
let app: { fetch: (r: Request) => Promise<Response> };
let db: typeof import('../src/core/db');
let oauth: typeof import('../src/integrations/oauth');
let watch: typeof import('../src/modules/content-watch');
let runtime: typeof import('../src/runtime/jobs');

async function call(who: Who | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = who ? { authorization: `Bearer ${who.token}`, ...(who.org ? { 'x-qline-org': who.org } : {}) } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }));
  const text = await res.clone().text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, res };
}
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

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
const connect = (w: Who) =>
  db.withTenant({ orgId: w.org!, userId: w.userId! }, (q) =>
    q.exec(
      `insert into integration_connections (org_id, workspace_id, provider, account_email, account_name, scopes, token_ciphertext, status, connected_by) values ($1,$2,'google','jazz@example.com','Test',$3,$4,'ok',$5)
       on conflict (org_id, provider) do update set status='ok'`,
      [w.org, w.ws, [GD + 'drive.readonly', GD + 'drive.file'], oauth.sealTokens(w.org!, 'google', { access_token: 'tok-google' }), w.userId],
    ),
  );

// ---- Fake Drive with a changes feed -------------------------------------------------------------
const FOLDER = 'application/vnd.google-apps.folder';
type Node = { id: string; name: string; mimeType: string; parents?: string[]; trashed?: boolean; size?: string; md5Checksum?: string; version?: string; content?: string };
let tree: Map<string, Node>;
let feed: string[]; // file ids, in change order; page token "t<n>" = after the first n changes
let minToken = 0; // tokens below this are "expired" (410)
let changeFailures: number[] = []; // statuses for the next changes.list calls
let watchFailures: number[] = [];
let stopFailures: number[] = [];
let watches: { id: string; token: string; address: string; expiration: string; pageToken: string }[] = [];
let stops: { id: string; resourceId: string }[] = [];
let seen: { method: string; url: string }[] = [];
const PAGE = 2;
const realFetch = globalThis.fetch;

const n = (id: string, mimeType: string, parent: string | null, extra: Partial<Node> = {}): Node => ({ id, name: id, mimeType, parents: parent ? [parent] : undefined, ...extra });
function baseTree() {
  const nodes = [
    n('myDrive', FOLDER, null),
    n('ROOT', FOLDER, 'myDrive'),
    n('ASSETS', FOLDER, 'ROOT'),
    n('a1.mp4', 'video/mp4', 'ASSETS', { size: '1048576', md5Checksum: 'abc123', version: '7' }),
    n('a2.png', 'image/png', 'ASSETS'),
    n('a3.txt', 'text/plain', 'ASSETS'),
    n('a4.jpg', 'image/jpeg', 'ASSETS'),
    n('SUB', FOLDER, 'ASSETS'),
    n('s1.mov', 'video/quicktime', 'SUB'),
    n('QA', FOLDER, 'ROOT'),
    n('REPORTS', FOLDER, 'ROOT'),
    n('OTHER_ROOT', FOLDER, 'myDrive'),
    n('OUTSIDE', FOLDER, 'OTHER_ROOT'),
  ];
  tree = new Map(nodes.map((x) => [x.id, x]));
  feed = [];
  minToken = 0;
}
/** Changes a file (or creates it, or deletes it with null) and appends it to the changes feed. */
function change(id: string, node: Partial<Node> | null) {
  if (node === null) tree.delete(id);
  else tree.set(id, { ...(tree.get(id) ?? { id, name: id, mimeType: 'application/octet-stream' }), ...node, id } as Node);
  feed.push(id);
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const meta = (f: Node) => {
  const { content: _c, ...m } = f;
  return m;
};
function installDrive() {
  seen = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    seen.push({ method, url: url.toString() });
    if (url.host !== 'www.googleapis.com') return json(599, { error: { message: `unstubbed ${url}` } });
    const p = url.pathname;
    if (method === 'GET' && p === '/drive/v3/changes/startPageToken') return json(200, { startPageToken: `t${feed.length}` });
    if (method === 'GET' && p === '/drive/v3/changes') {
      const fail = changeFailures.shift();
      if (fail) return json(fail, { error: { message: `fake ${fail}` } });
      const m = url.searchParams.get('pageToken')?.match(/^t(\d+)$/);
      const at = m ? Number(m[1]) : -1;
      if (at < minToken || at > feed.length) return json(410, { error: { message: 'Invalid page token' } });
      const ids = feed.slice(at, at + PAGE);
      const changes = ids.map((id) => (tree.has(id) ? { changeType: 'file', fileId: id, removed: false, file: meta(tree.get(id)!) } : { changeType: 'file', fileId: id, removed: true }));
      const more = at + PAGE < feed.length;
      return json(200, { changes, ...(more ? { nextPageToken: `t${at + PAGE}` } : { newStartPageToken: `t${feed.length}` }) });
    }
    if (method === 'POST' && p === '/drive/v3/changes/watch') {
      const fail = watchFailures.shift();
      if (fail) return json(fail, { error: { message: `fake ${fail}` } });
      const b = JSON.parse(init.body);
      watches.push({ ...b, pageToken: url.searchParams.get('pageToken') });
      return json(200, { kind: 'api#channel', id: b.id, resourceId: `res-${b.id.slice(0, 8)}`, resourceUri: 'x', expiration: b.expiration });
    }
    if (method === 'POST' && p === '/drive/v3/channels/stop') {
      const fail = stopFailures.shift();
      if (fail) return json(fail, { error: { message: `fake ${fail}` } });
      stops.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    const one = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (method === 'GET' && one) {
      const f = tree.get(decodeURIComponent(one[1]!));
      if (!f) return json(404, { error: { message: 'File not found' } });
      if (url.searchParams.get('alt') === 'media') return new Response(f.content ?? '', { status: 200 });
      return json(200, meta(f));
    }
    if (method === 'GET' && p === '/drive/v3/files') {
      const parent = url.searchParams.get('q')?.match(/^'([^']+)' in parents and trashed = false$/)?.[1];
      if (!parent) return json(400, { error: { message: 'unexpected query' } });
      const kids = [...tree.values()].filter((f) => f.parents?.includes(parent) && !f.trashed);
      const at = Number(url.searchParams.get('pageToken') ?? 0);
      return json(200, { files: kids.slice(at, at + PAGE).map(meta), ...(at + PAGE < kids.length ? { nextPageToken: String(at + PAGE) } : {}) });
    }
    return json(599, { error: { message: `unstubbed ${method} ${url}` } });
  }) as typeof fetch;
}

const MAP = { rootFolderId: 'ROOT', roles: { assets: ['ASSETS'], ready_for_qa: 'QA', external_reports: 'REPORTS' } };
const MD5 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HOOK = 'https://hooks.test.qline.dev/v1/hooks/drive';

d('content handoff run 5: Drive change tracking and reconciliation (integration)', () => {
  const asOrg = (w: Who, fn: (q: any) => Promise<any>): Promise<any> => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);
  const cfgRow = (w: Who) => asOrg(w, (q) => q.one('select * from content_drive_config where workspace_id=$1', [w.ws]));
  const asset = (w: Who, id: string) => asOrg(w, (q) => q.one('select drive_file_id, name, role, depth, parent_id, state from content_assets where workspace_id=$1 and drive_file_id=$2', [w.ws, id]));
  const jobsOf = (w: Who, kind: string) => asOrg(w, (q) => q.many(`select id, status, attempts, last_error, result, run_at, idempotency_key from jobs where org_id=$1 and kind=$2 order by created_at`, [w.org, kind]));
  /** Runs this org's due content jobs, the way the tick's drain would, but never other test files' jobs. */
  async function runJobs(w: Who) {
    for (let i = 0; i < 20; i++) {
      const due = await asOrg(w, (q) => q.many(`select id from jobs where org_id=$1 and kind like 'content.%' and status='queued' and run_at <= now() order by created_at`, [w.org]));
      if (!due.length) return;
      for (const j of due) await runtime.runInline(j.id);
    }
  }
  async function tick(w: Who) {
    await asOrg(w, (q) => q.exec('update content_drive_config set last_reconciled_at=null where workspace_id=$1', [w.ws]));
    const r = await watch.runContentReconcile({ limit: 200, orgIds: [w.org!] });
    await runJobs(w);
    return r;
  }
  async function syncJob(w: Who) {
    await asOrg(w, (q) => runtime.enqueue(q, { orgId: w.org!, kind: 'content.drive_sync', payload: { workspaceId: w.ws, reason: 'hook' }, idempotencyKey: randomUUID(), maxAttempts: 6, createdBy: 'test' }));
    await runJobs(w);
    return (await jobsOf(w, 'content.drive_sync')).at(-1);
  }
  async function workspace(name: string) {
    const w = await setup(name);
    await connect(w);
    expect((await call(w, 'PUT', '/content/drive-config', MAP)).status).toBe(200);
    expect((await call(w, 'POST', '/content/drive-config/validate')).json.status).toBe('valid');
    return w;
  }
  async function hook(headers: Record<string, string>) {
    const res = await app.fetch(new Request('http://localhost/v1/hooks/drive', { method: 'POST', headers }));
    return res.status;
  }
  async function newJob(w: Who, title: string) {
    const r = await call(w, 'POST', '/content/jobs', { title, brief: 'Cut it.', assetIds: ['a1.mp4'] });
    expect(r.status).toBe(201);
    const res = await app.fetch(new Request(`http://localhost/v1/content/jobs/${r.json.id}/manifest`, { headers: { authorization: `Bearer ${w.token}`, 'x-qline-org': w.org! } }));
    const man = JSON.parse(await res.text());
    return { ...r.json, nonce: man.nonce, out: man.expectedOutputs[0].fileName };
  }
  const report = (j: any, o: Record<string, unknown> = {}) => JSON.stringify({ schema: 'qline.content.result/1', jobId: j.jobCode, revision: j.revision, nonce: j.nonce, status: 'completed', ...o });
  const ledger = (w: Who, j: any) =>
    asOrg(w, async (q) => ({
      events: (await q.many('select source, event_key, event_type from content_job_events where job_id=$1 order by received_at, event_key', [j.id])).map((e: any) => `${e.source}:${e.event_type}:${e.event_key}`),
      acks: (await q.one('select count(*)::int as n from content_job_acks where job_id=$1', [j.id])).n,
      notes: (await q.one(`select count(*)::int as n from notifications where dedupe_key like $1`, [`content:${j.id}:%`])).n,
      tasks: (await q.one(`select count(*)::int as n from tasks where source_ref=$1`, [`content_job:${j.id}`])).n,
    }));

  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    oauth = await import('../src/integrations/oauth');
    watch = await import('../src/modules/content-watch');
    runtime = await import('../src/runtime/jobs');
    baseTree();
    installDrive();
  });
  afterEach(() => {
    // Read-only for files: the only non-GET Drive calls are the notification channel ones.
    for (const s of seen) {
      if (s.method !== 'GET') expect(['/drive/v3/changes/watch', '/drive/v3/channels/stop']).toContain(new URL(s.url).pathname);
      expect(s.url).not.toContain('/upload/');
    }
    delete process.env.QLINE_DRIVE_WEBHOOK_URL;
    changeFailures = [];
    watchFailures = [];
    stopFailures = [];
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.closePool();
  });

  it('starts with a full listing, then applies changes page by page, only inside the mapped folders', async () => {
    const A = await workspace('Track');
    expect((await call(A, 'GET', '/content/drive-config')).json.changes.cursor).toBe('none');
    await tick(A);
    let cfg = await cfgRow(A);
    expect(cfg.cursor_status).toBe('ok');
    expect(cfg.start_page_token).toBe(`t${feed.length}`);
    expect(cfg.folder_index.map((f: any) => `${f.role}:${f.id}:${f.depth}`).sort()).toEqual(['assets:ASSETS:0', 'assets:SUB:1', 'external_reports:REPORTS:0', 'ready_for_qa:QA:0']);
    expect((await asset(A, 'a2.png')).state).toBe('indexed');
    expect((await jobsOf(A, 'content.reconcile'))[0].result.sync.rescan).toBe('first_sync');

    change('new.mp4', n('new.mp4', 'video/mp4', 'ASSETS'));
    change('a2.png', { name: 'renamed.png' });
    change('a3.txt', { parents: ['OUTSIDE'] }); // moved out of the mapped tree
    change('a4.jpg', { trashed: true });
    change('o2.txt', n('o2.txt', 'text/plain', 'OUTSIDE')); // never in a mapped folder
    change('s2.mov', n('s2.mov', 'video/quicktime', 'SUB')); // inside a folder found by the listing
    change('gone', null); // deleted, never known
    seen = [];
    const j = await syncJob(A);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ mode: 'changes', pages: 4, changes: 7, rescan: null, more: false });
    // no folder re-listing: the changes feed was enough; only the Reports folder is read for new reports
    expect(seen.filter((s) => new URL(s.url).pathname === '/drive/v3/files').map((s) => new URL(s.url).searchParams.get('q'))).toEqual(["'REPORTS' in parents and trashed = false"]);
    expect((await asset(A, 'new.mp4'))).toMatchObject({ role: 'assets', parent_id: 'ASSETS', state: 'indexed' });
    expect((await asset(A, 'a2.png')).name).toBe('renamed.png');
    expect((await asset(A, 'a3.txt')).state).toBe('removed');
    expect((await asset(A, 'a4.jpg')).state).toBe('removed');
    expect(await asset(A, 'o2.txt')).toBeNull();
    expect(await asset(A, 'gone')).toBeNull();
    expect((await asset(A, 's2.mov'))).toMatchObject({ role: 'assets', parent_id: 'SUB', depth: 1, state: 'indexed' });
    cfg = await cfgRow(A);
    expect(cfg.start_page_token).toBe(`t${feed.length}`);
    expect(cfg.sync_lease_owner).toBeNull();
    // nothing new: one page, nothing applied
    const again = await syncJob(A);
    expect(again.result).toMatchObject({ pages: 1, changes: 0, applied: 0 });
    // tidy the shared tree for later tests
    change('a2.png', { name: 'a2.png' });
    change('a3.txt', { parents: ['ASSETS'] });
    change('a4.jpg', { trashed: false });
  });

  it('lists again when folders change inside the tree, and re-checks the boundary when a mapped folder moves', async () => {
    const A = await workspace('Folders');
    await tick(A);
    change('NEWSUB', n('NEWSUB', FOLDER, 'ASSETS'));
    tree.set('n1.png', n('n1.png', 'image/png', 'NEWSUB')); // created inside the new folder before Qline looks
    const j = await syncJob(A);
    expect(j.result.rescan).toBe('folders_changed');
    expect((await asset(A, 'n1.png'))).toMatchObject({ role: 'assets', parent_id: 'NEWSUB', depth: 1, state: 'indexed' });
    expect((await cfgRow(A)).folder_index.some((f: any) => f.id === 'NEWSUB')).toBe(true);

    // The Ready for QA folder is moved out of the root: the mapping stops being valid.
    change('QA', { parents: ['OTHER_ROOT'] });
    const k = await syncJob(A);
    expect(k.result.mapping).toBe('invalid');
    const cfg = (await call(A, 'GET', '/content/drive-config')).json;
    expect(cfg.status).toBe('invalid');
    expect(cfg.lastError).toMatch(/Check the folder mapping again/);
    expect(cfg.validation.folders.find((f: any) => f.role === 'ready_for_qa').reason).toBe('outside_root');
    // no more syncing until it is fixed and checked again
    expect((await syncJob(A)).result.mode).toBe('skipped');
    change('QA', { parents: ['ROOT'] });
    change('NEWSUB', { trashed: true });
    expect((await call(A, 'POST', '/content/drive-config/validate')).json.status).toBe('valid');
    expect((await cfgRow(A)).cursor_status).toBe('none'); // a fresh validation restarts with a full listing
  });

  it('a stale cursor leads to a full listing and a fresh token', async () => {
    const A = await workspace('Stale');
    await tick(A);
    change('late.png', n('late.png', 'image/png', 'ASSETS'));
    minToken = feed.length; // Drive forgets every older token
    const j = await syncJob(A);
    expect(j.status).toBe('succeeded');
    expect(j.result).toMatchObject({ mode: 'rescan', rescan: 'stale_cursor' });
    const cfg = await cfgRow(A);
    expect(cfg.cursor_status).toBe('ok');
    expect(cfg.start_page_token).toBe(`t${feed.length}`);
    expect((await asset(A, 'late.png')).state).toBe('indexed');
    minToken = 0;
  });

  it('a missed webhook is covered by the tick: the report is read and verified once', async () => {
    const A = await workspace('Missed');
    await tick(A);
    const job = await newJob(A, 'Missed hook');
    change(`${job.out}`, { ...n(job.out, 'video/mp4', 'QA'), size: '5000000', md5Checksum: MD5, version: '1' });
    change(`rep-${job.jobCode}`, { ...n(`rep-${job.jobCode}`, 'application/json', 'REPORTS'), name: `${job.jobCode}-r1.result.json`, version: '1', content: report(job, { outputs: [{ driveFileId: job.out, name: job.out, md5: MD5, sizeBytes: 5000000 }] }) });
    // no webhook arrives; the 10-minute reconciliation finds it
    await tick(A);
    const s = (await call(A, 'GET', `/content/jobs/${job.id}`)).json;
    expect(s.state).toBe('awaiting_video_qa');
    const first = await ledger(A, job);
    expect(first.tasks).toBe(1);
    // more ticks and syncs change nothing
    await tick(A);
    await syncJob(A);
    expect(await ledger(A, job)).toEqual(first);
    // a second tick inside the same 10 minutes queues nothing
    expect((await watch.runContentReconcile({ limit: 200, orgIds: [A.org!] })).queued).toBe(0);
  });

  it('retries 429 and 5xx with backoff and records them; a refused sign-in asks to reconnect', async () => {
    const A = await workspace('Retry');
    await tick(A);
    change('r1.png', n('r1.png', 'image/png', 'ASSETS'));
    for (const status of [429, 503]) {
      changeFailures = [status];
      const j = await syncJob(A);
      expect(j.status).toBe('queued'); // waiting for its retry
      expect(j.attempts).toBe(1);
      expect(new Date(j.run_at).getTime()).toBeGreaterThan(Date.now());
      expect(j.last_error).toMatch(/not answering/);
      expect((await call(A, 'GET', '/content/drive-config')).json.lastError).toMatch(/not answering/);
      await asOrg(A, (q) => q.exec('update jobs set run_at=now() where id=$1', [j.id]));
      await runJobs(A);
      const done = (await jobsOf(A, 'content.drive_sync')).find((x: any) => x.id === j.id);
      expect(done.status).toBe('succeeded');
      expect((await call(A, 'GET', '/content/drive-config')).json.lastError).toBeNull();
    }
    expect((await asset(A, 'r1.png')).state).toBe('indexed');
    changeFailures = [401];
    const k = await syncJob(A);
    expect(k.status).toBe('failed'); // not retried
    expect((await call(A, 'GET', '/content/drive-config')).json.lastError).toMatch(/^Reconnect Google/);
  });

  it('a crash mid-sync leaves the lease to run out; the next run resumes from the saved cursor with no duplicates', async () => {
    const A = await workspace('Crash');
    await tick(A);
    const job = await newJob(A, 'Crash');
    const from = `t${feed.length}`;
    change('c1.png', n('c1.png', 'image/png', 'ASSETS'));
    change('c2.png', n('c2.png', 'image/png', 'ASSETS'));
    change(job.out, { ...n(job.out, 'video/mp4', 'QA'), size: '5000000', md5Checksum: MD5, version: '1' });
    change(`rep-${job.jobCode}`, { ...n(`rep-${job.jobCode}`, 'application/json', 'REPORTS'), name: `${job.jobCode}-r1.result.json`, version: '1', content: report(job, { outputs: [{ driveFileId: job.out, name: job.out }] }) });
    // A worker took the lease, committed its first page (c1, c2) and died.
    await asOrg(A, (q) => q.exec(`update content_drive_config set sync_lease_owner='job:dead:1', sync_lease_until=now() + interval '60 seconds', start_page_token=$2 where workspace_id=$1`, [A.ws, `t${Number(from.slice(1)) + 2}`]));
    // While its lease lasts, another sync waits (retried with backoff, not recorded as a Drive error).
    const busy = await syncJob(A);
    expect(busy.status).toBe('queued');
    expect(busy.last_error).toMatch(/Another Drive sync is running/);
    expect((await cfgRow(A)).last_error).toBeNull();
    expect(await call(A, 'POST', '/content/sync').then((r) => r.json.code)).toBe('SYNC_BUSY');
    // The lease runs out; the retry takes over and continues from the saved cursor.
    await asOrg(A, (q) => q.exec(`update content_drive_config set sync_lease_until=now() - interval '1 second' where workspace_id=$1`, [A.ws]));
    await asOrg(A, (q) => q.exec('update jobs set run_at=now() where id=$1', [busy.id]));
    await runJobs(A);
    const done = (await jobsOf(A, 'content.drive_sync')).find((x: any) => x.id === busy.id);
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ mode: 'changes', changes: 2 });
    expect((await call(A, 'GET', `/content/jobs/${job.id}`)).json.state).toBe('awaiting_video_qa');
    const once = await ledger(A, job);
    expect(once.tasks).toBe(1);
    // Now the worse case: it crashed after reading the report but before the cursor moved. The page is read again.
    await asOrg(A, (q) => q.exec(`update content_drive_config set start_page_token=$2 where workspace_id=$1`, [A.ws, from]));
    const replay = await syncJob(A);
    expect(replay.status).toBe('succeeded');
    expect(replay.result.changes).toBe(4);
    expect(await ledger(A, job)).toEqual(once); // no duplicate events, acks, notifications or review tasks
    const counts = await asOrg(A, (q) => q.many(`select drive_file_id, count(*)::int as n from content_assets where workspace_id=$1 group by 1 having count(*) > 1`, [A.ws]));
    expect(counts).toEqual([]);
  });

  it('opens a push channel and verifies webhook calls by channel, token, resource and expiry', async () => {
    process.env.QLINE_DRIVE_WEBHOOK_URL = HOOK;
    const A = await workspace('Hook');
    watches = [];
    await tick(A);
    expect(watches.length).toBe(1);
    const w = watches[0]!;
    expect(w.address).toBe(HOOK);
    const cfg = await cfgRow(A);
    expect(cfg.channel_id).toBe(w.id);
    expect(cfg.channel_token_hash).toBe(sha(w.token)); // only the hash is stored
    expect(JSON.stringify(cfg)).not.toContain(w.token);
    expect(Number(w.expiration) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await call(A, 'GET', '/content/drive-config')).json.changes.watching).toBe(true);
    const h = { 'x-goog-channel-id': w.id, 'x-goog-channel-token': w.token, 'x-goog-resource-id': cfg.resource_id, 'x-goog-resource-state': 'change', 'x-goog-message-number': '2' };
    expect(await hook({ ...h, 'x-goog-channel-token': 'wrong' })).toBe(404);
    expect(await hook({ ...h, 'x-goog-channel-id': randomUUID() })).toBe(404);
    expect(await hook({ ...h, 'x-goog-resource-id': 'other' })).toBe(404);
    expect(await hook({})).toBe(404);
    expect(await hook({ ...h, 'x-goog-resource-state': 'sync' })).toBe(204);
    expect((await jobsOf(A, 'content.drive_sync')).length).toBe(0); // sync messages do no work
    change('h1.png', n('h1.png', 'image/png', 'ASSETS'));
    expect(await hook(h)).toBe(204);
    expect(await hook(h)).toBe(204); // a burst collapses into one queued sync
    expect((await jobsOf(A, 'content.drive_sync')).length).toBe(1);
    await runJobs(A);
    expect((await asset(A, 'h1.png')).state).toBe('indexed');
    // another organization's channel token does not open this one
    process.env.QLINE_DRIVE_WEBHOOK_URL = HOOK;
    const B = await workspace('HookB');
    await tick(B);
    const wb = watches.at(-1)!;
    expect(wb.id).not.toBe(w.id);
    expect(await hook({ ...h, 'x-goog-channel-token': wb.token })).toBe(404);
  });

  it('renews a channel with less than 24 h left, stopping the old one only after the new one is confirmed', async () => {
    process.env.QLINE_DRIVE_WEBHOOK_URL = HOOK;
    const A = await workspace('Renew');
    watches = [];
    stops = [];
    await tick(A);
    const first = watches.at(-1)!;
    const firstCfg = await cfgRow(A);
    // nothing to do while more than a day is left
    await tick(A);
    expect(watches.length).toBe(1);
    // 2 h left: renew; a failed stop keeps the old channel accepted until it expires
    await asOrg(A, (q) => q.exec(`update content_drive_config set channel_expires_at=now() + interval '2 hours' where workspace_id=$1`, [A.ws]));
    stopFailures = [503];
    seen = [];
    await tick(A);
    expect(watches.length).toBe(2);
    const second = watches.at(-1)!;
    const order = seen.filter((s) => s.method === 'POST').map((s) => new URL(s.url).pathname);
    expect(order).toEqual(['/drive/v3/changes/watch', '/drive/v3/channels/stop']); // new confirmed first
    let cfg = await cfgRow(A);
    expect(cfg.channel_id).toBe(second.id);
    expect(cfg.prev_channel_id).toBe(first.id);
    const oldH = { 'x-goog-channel-id': first.id, 'x-goog-channel-token': first.token, 'x-goog-resource-id': firstCfg.resource_id, 'x-goog-resource-state': 'change' };
    expect(await hook(oldH)).toBe(204);
    // next tick: the old one is stopped and forgotten
    await tick(A);
    expect(stops.map((s) => s.id)).toContain(first.id);
    cfg = await cfgRow(A);
    expect(cfg.prev_channel_id).toBeNull();
    expect(await hook(oldH)).toBe(404);
    // an expired channel is refused, and the tick replaces it
    await asOrg(A, (q) => q.exec(`update content_drive_config set channel_expires_at=now() - interval '1 minute' where workspace_id=$1`, [A.ws]));
    expect(await hook({ 'x-goog-channel-id': second.id, 'x-goog-channel-token': second.token, 'x-goog-resource-id': cfg.resource_id, 'x-goog-resource-state': 'change' })).toBe(404);
    await tick(A);
    expect(watches.length).toBe(3);
    expect((await cfgRow(A)).channel_id).toBe(watches.at(-1)!.id);
    // a failed watch keeps the current channel
    await asOrg(A, (q) => q.exec(`update content_drive_config set channel_expires_at=now() + interval '1 hour' where workspace_id=$1`, [A.ws]));
    const before = (await cfgRow(A)).channel_id;
    watchFailures = [500];
    await tick(A);
    expect((await cfgRow(A)).channel_id).toBe(before);
    expect((await jobsOf(A, 'content.reconcile')).at(-1).result.channel).toBe('error');
    // turning the webhook off stops and clears the channel
    delete process.env.QLINE_DRIVE_WEBHOOK_URL;
    await tick(A);
    cfg = await cfgRow(A);
    expect(cfg.channel_id).toBeNull();
    expect(stops.map((s) => s.id)).toContain(before);
  });

  it('the sweep expires jobs past their date and flags quiet jobs once', async () => {
    const A = await workspace('Sweep');
    await tick(A);
    const old = await newJob(A, 'Old');
    const quiet = await newJob(A, 'Quiet');
    await asOrg(A, (q) => q.exec(`update content_jobs set expires_at=now() - interval '1 minute' where id=$1`, [old.id]));
    await asOrg(A, (q) => q.exec(`update content_jobs set last_activity_at=now() - interval '4 days' where id=$1`, [quiet.id]));
    await tick(A);
    expect((await call(A, 'GET', `/content/jobs/${old.id}`)).json.state).toBe('expired');
    const q1 = (await call(A, 'GET', `/content/jobs/${quiet.id}`)).json;
    expect(q1.state).toBe('prepared');
    expect(q1.stale).toBe(true);
    const a = await ledger(A, old);
    const b = await ledger(A, quiet);
    expect(a.notes).toBeGreaterThan(0);
    expect(b.events.filter((e: string) => e.includes('job.stale')).length).toBe(1);
    await tick(A);
    expect(await ledger(A, old)).toEqual(a);
    expect(await ledger(A, quiet)).toEqual(b);
    // an expired job accepts no report
    const res = await app.fetch(new Request(`http://localhost/v1/content/jobs/${old.id}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'x-qline-org': A.org! }, body: report(old, { status: 'accepted' }) }));
    expect((await res.json()).findings[0].code).toBe('job_closed');
    // activity clears the flag
    const r2 = await app.fetch(new Request(`http://localhost/v1/content/jobs/${quiet.id}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${A.token}`, 'x-qline-org': A.org! }, body: report(quiet, { status: 'accepted' }) }));
    expect((await r2.json()).outcome).toBe('applied');
    expect((await call(A, 'GET', `/content/jobs/${quiet.id}`)).json.stale).toBe(false);
  });

  it('keeps tenants apart: a sync, tick or webhook for one workspace never touches another', async () => {
    const A = await workspace('IsoA');
    const B = await workspace('IsoB');
    await tick(A);
    expect((await cfgRow(B)).cursor_status).toBe('none'); // B was not reconciled by A's tick
    expect(await asOrg(A, (q) => q.many('select 1 from content_drive_config where workspace_id=$1', [B.ws]))).toEqual([]);
    expect(await asOrg(A, (q) => q.many(`select 1 from jobs where payload->>'workspaceId'=$1`, [B.ws]))).toEqual([]);
    const audits = await asOrg(A, (q) => q.many(`select actor_kind, actor_id from audit_events where action='content.drive_synced' and target_ref=$1`, [`workspace:${A.ws}`]));
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((x: any) => x.actor_kind === 'system' && x.actor_id === 'system:content')).toBe(true);
  });
});
