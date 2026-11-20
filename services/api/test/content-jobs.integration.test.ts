/**
 * Content handoff run 3 / Slice 2a (docs/22 ADR-C2, C5, C7): content jobs, the stored manifest and editor PDF, cancel
 * and reissue, plus the Command Center label. Real Postgres as the app role (RLS on). Google Drive is a fake in-memory
 * tree behind a fetch stub, used only to index assets; creating jobs calls nothing outside Qline.
 * Needs QLINE_TEST_ENV; skipped otherwise.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  const text = await res.clone().text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, res };
}
async function raw(who: Who, path: string) {
  const res = await app.fetch(new Request(`http://localhost/v1${path}`, { headers: { authorization: `Bearer ${who.token}`, 'x-qline-org': who.org! } }));
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
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
const asOrg = (w: Who, fn: (q: any) => Promise<any>): Promise<any> => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);
const JOB = { title: 'Launch teaser – 15s', brief: 'Cut a vertical teaser from the clips. Keep the logo “Qline” visible.', assetIds: ['a1.mp4', 'a2.png'], constraints: { aspectRatio: '9:16', maxDurationSec: 15 } };

d('content handoff run 3: content jobs, manifest and editor PDF (integration)', () => {
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

  it('refuses jobs until the mapping is valid', async () => {
    expect((await call(A, 'POST', '/content/jobs', JOB)).json.code).toBe('NOT_CONFIGURED');
    expect((await call(A, 'PUT', '/content/drive-config', GOOD)).status).toBe(200);
    expect((await call(A, 'POST', '/content/jobs', JOB)).json.code).toBe('NOT_VALIDATED');
    baseTree();
    installDrive();
    expect((await call(A, 'POST', '/content/drive-config/validate')).json.status).toBe('valid');
    expect((await call(A, 'POST', '/content/sync')).status).toBe(200);
    // a5.jpg disappears from Drive: after the next sync it is "removed"
    tree.delete('a5.jpg');
    expect((await call(A, 'POST', '/content/sync')).status).toBe(200);
    const removed = (await call(A, 'GET', '/content/assets?state=removed')).json.items.map((x: any) => x.driveFileId);
    expect(removed).toContain('a5.jpg');
    globalThis.fetch = realFetch;
  });

  it('only indexed files from an assets folder can go into a job', async () => {
    globalThis.fetch = (async () => {
      throw new Error('creating a job must not call any outside service');
    }) as any;
    for (const bad of ['a5.jpg', 'sc-link', 'out.mp4', 'no-such-file', 'o1.txt']) {
      const r = await call(A, 'POST', '/content/jobs', { ...JOB, assetIds: ['a1.mp4', bad] });
      expect(r.status, bad).toBe(400);
      expect(r.json.detail).toContain(bad);
      expect(r.json.detail).not.toContain('a1.mp4,');
    }
    expect((await call(A, 'POST', '/content/jobs', { ...JOB, assetIds: ['a1.mp4', 'a1.mp4'] })).status).toBe(400);
    expect((await call(A, 'POST', '/content/jobs', { ...JOB, assetIds: [] })).status).toBe(400);
    expect((await call(A, 'POST', '/content/jobs', { ...JOB, extra: 1 })).status).toBe(400);
    expect((await call(A, 'POST', '/content/jobs', { ...JOB, constraints: { aspectRatio: '2:1' } })).status).toBe(400);
    expect((await call(A, 'POST', '/content/jobs', { ...JOB, missionId: randomUUID() })).status).toBe(400);
    const none = await asOrg(A, (q) => q.many('select 1 from content_jobs'));
    expect(none.length).toBe(0);
  });

  let job: any;
  it('creates a job with a well-formed code and a manifest of exactly the chosen indexed assets', async () => {
    globalThis.fetch = (async () => {
      throw new Error('creating a job must not call any outside service');
    }) as any;
    const r = await call(M, 'POST', '/content/jobs', { ...JOB, assetIds: ['a2.png', 's1.mov', 'a1.mp4'] }); // members can create jobs
    expect(r.status).toBe(201);
    job = r.json;
    expect(job.jobCode).toMatch(/^QLINE-\d{8}-[0-9a-hjkmnp-tv-z]{6}$/);
    expect(job.jobCode.slice(6, 14)).toBe(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    expect(job.state).toBe('prepared');
    expect(job.externalStatus).toBeNull();
    expect(job.revision).toBe(1);
    expect(job).not.toHaveProperty('nonce');
    expect(job).not.toHaveProperty('manifestJson');

    const m = await raw(A, `/content/jobs/${job.id}/manifest`);
    expect(m.res.status).toBe(200);
    expect(m.res.headers.get('content-type')).toContain('application/json');
    expect(m.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(m.res.headers.get('content-disposition')).toBe(`attachment; filename="${job.jobCode}-r1.manifest.json"`);
    expect(sha(m.bytes)).toBe(job.manifestSha256);
    const man = JSON.parse(new TextDecoder().decode(m.bytes));
    expect(Object.keys(man)).toEqual(['schema', 'jobId', 'revision', 'nonce', 'createdAt', 'issuedAt', 'expiresAt', 'title', 'brief', 'editorTarget', 'inputs', 'constraints', 'expectedOutputs', 'return', 'rules', 'resultExample']);
    expect(man.schema).toBe('qline.content.manifest/1');
    expect(man.jobId).toBe(job.jobCode);
    expect(man.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(man.inputs.map((i: any) => i.driveFileId)).toEqual(['a1.mp4', 'a2.png', 's1.mov']); // sorted by name
    expect(man.inputs[0]).toEqual({ driveFileId: 'a1.mp4', name: 'a1.mp4', mimeType: 'video/mp4', sizeBytes: 1048576, md5: 'abc123', version: 7, webViewLink: null });
    expect(man.constraints).toEqual({ aspectRatio: '9:16', maxDurationSec: 15, notes: null });
    expect(man.expectedOutputs).toEqual([{ kind: 'video', fileName: `${job.jobCode}-r1.mp4`, mimeType: 'video/mp4' }]);
    expect(man.return).toEqual({ readyForQaFolderId: 'QA', externalReportsFolderId: 'REPORTS', resultFileName: `${job.jobCode}-r1.result.json` });
    expect(man.resultExample).toMatchObject({ schema: 'qline.content.result/1', jobId: job.jobCode, revision: 1, nonce: man.nonce, status: 'completed' });
    expect(new Date(man.expiresAt).getTime() - new Date(man.issuedAt).getTime()).toBe(14 * 86_400_000);
    expect(JSON.stringify(man)).not.toMatch(/tok-google|token_ciphertext|access_token/i);

    // the stored row agrees with the download
    const row = await asOrg(A, (q) => q.one('select nonce, manifest_json, input_file_ids from content_jobs where id=$1', [job.id]));
    expect(row.nonce).toBe(man.nonce);
    expect(row.input_file_ids).toEqual(['a1.mp4', 'a2.png', 's1.mov']);
  });

  it('the editor PDF is a real PDF with the job details and matches its stored checksum', async () => {
    const p = await raw(A, `/content/jobs/${job.id}/pdf`);
    expect(p.res.status).toBe(200);
    expect(p.res.headers.get('content-type')).toBe('application/pdf');
    expect(p.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new TextDecoder().decode(p.bytes.slice(0, 8))).toBe('%PDF-1.4');
    expect(sha(p.bytes)).toBe(job.pdfSha256);
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(p.bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    for (const s of [job.jobCode, 'a1.mp4', 'a2.png', 's1.mov', `${job.jobCode}-r1.mp4`, 'Launch teaser – 15s', '“Qline”', 'qline.content.result/1', 'read-only']) expect(text, s).toContain(s);
    // the same manifest always gives the same bytes
    const pdfMod = await import('../src/modules/content-jobs');
    const man = JSON.parse(new TextDecoder().decode((await raw(A, `/content/jobs/${job.id}/manifest`)).bytes));
    expect(sha(pdfMod.manifestPdf(man))).toBe(job.pdfSha256);
  });

  it('long briefs wrap onto more pages and still parse', async () => {
    const brief = Array.from({ length: 80 }, (_, i) => `Line ${i}: ${'word '.repeat(6)}`).join('\n') + ' ' + 'x'.repeat(300);
    const r = await call(A, 'POST', '/content/jobs', { ...JOB, brief });
    expect(r.status).toBe(201);
    const p = await raw(A, `/content/jobs/${r.json.id}/pdf`);
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(p.bytes));
    expect(pdf.numPages).toBeGreaterThan(1);
    const { text } = await extractText(pdf, { mergePages: true });
    expect(brief.length).toBeLessThanOrEqual(4000);
    expect(text).toContain('Line 79');
    expect(text).toContain('x'.repeat(40));
    expect(text).toContain(`Page 1 of ${pdf.numPages}`);
  });

  it('job codes are unique per organization', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) codes.add((await call(A, 'POST', '/content/jobs', JOB)).json.jobCode);
    const all = await asOrg(A, (q) => q.many('select job_code from content_jobs'));
    expect(new Set(all.map((x: any) => x.job_code)).size).toBe(all.length);
    expect(codes.size).toBe(5);
    // the database refuses a duplicate code and a malformed one
    const dup = (code: string) =>
      asOrg(A, (q) =>
        q.exec(
          `insert into content_jobs (org_id, workspace_id, job_code, title, editor_target, nonce, input_file_ids, manifest_json, manifest_sha256, pdf, pdf_sha256, created_by, expires_at)
           values ($1,$2,$3,'t','x','n','{}','{}','s','\\x00','s',$4, now())`,
          [A.org, A.ws, code, A.userId],
        ),
      );
    await expect(dup(job.jobCode)).rejects.toThrow(/duplicate key/);
    await expect(dup('QLINE-20261120-ABCDEF')).rejects.toThrow(/check constraint/);
  });

  it('lists jobs by filter and shows detail with its event history', async () => {
    const active = (await call(M, 'GET', '/content/jobs?filter=active')).json.items;
    expect(active.map((j: any) => j.id)).toContain(job.id);
    expect((await call(A, 'GET', '/content/jobs?filter=failed')).json.items.length).toBe(0);
    expect((await call(A, 'GET', '/content/jobs?filter=nope')).status).toBe(400);
    const det = (await call(M, 'GET', `/content/jobs/${job.id}`)).json;
    expect(det.events.map((e: any) => [e.source, e.event_key, e.event_type])).toEqual([['qline', 'created:r1', 'job.created']]);
    expect(det.outputs).toEqual([]);
    expect(det.acks).toEqual([]);
    expect((await call(A, 'GET', `/content/jobs/${randomUUID()}`)).status).toBe(404);
    expect((await call(A, 'GET', '/content/jobs/not-a-uuid')).status).toBe(404);
  });

  it('reissue makes a new revision with a new nonce; stale revisions are refused', async () => {
    const before = JSON.parse(new TextDecoder().decode((await raw(A, `/content/jobs/${job.id}/manifest`)).bytes));
    expect((await call(A, 'POST', `/content/jobs/${job.id}/reissue`, { revision: 2 })).json.code).toBe('STALE_REVISION');
    expect((await call(A, 'POST', `/content/jobs/${job.id}/reissue`, { revision: 1, assetIds: ['a5.jpg'] })).status).toBe(400);
    const r = await call(M, 'POST', `/content/jobs/${job.id}/reissue`, { revision: 1, assetIds: ['a1.mp4'], brief: 'Shorter please.' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ jobCode: job.jobCode, revision: 2, state: 'prepared', brief: 'Shorter please.', inputFileIds: ['a1.mp4'] });
    expect(r.json.manifestSha256).not.toBe(job.manifestSha256);
    const after = JSON.parse(new TextDecoder().decode((await raw(A, `/content/jobs/${job.id}/manifest`)).bytes));
    expect(after.revision).toBe(2);
    expect(after.nonce).not.toBe(before.nonce);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.expectedOutputs[0].fileName).toBe(`${job.jobCode}-r2.mp4`);
    expect(after.inputs.map((i: any) => i.driveFileId)).toEqual(['a1.mp4']);
    const p = await raw(A, `/content/jobs/${job.id}/pdf`);
    expect(sha(p.bytes)).toBe(r.json.pdfSha256);
    // a second reissue with the old revision loses
    expect((await call(A, 'POST', `/content/jobs/${job.id}/reissue`, { revision: 1 })).json.code).toBe('STALE_REVISION');
    const det = (await call(A, 'GET', `/content/jobs/${job.id}`)).json;
    expect(det.events.map((e: any) => e.event_key)).toEqual(['created:r1', 'reissued:r2']);
    expect(det.events[1].detail.previousManifestSha256).toBe(job.manifestSha256);
    job = r.json;
  });

  it('reissue is refused for jobs that are awaiting review or verified', async () => {
    const other = (await call(A, 'POST', '/content/jobs', JOB)).json;
    for (const s of ['awaiting_video_qa', 'output_verified']) {
      await db.withTenant({ orgId: A.org!, userId: A.userId! }, (q) => q.exec('update content_jobs set qline_state=$2 where id=$1', [other.id, s]));
      expect((await call(A, 'POST', `/content/jobs/${other.id}/reissue`, { revision: 1 })).json.code).toBe('CANNOT_REISSUE');
    }
    // failed jobs may be reissued
    await asOrg(A, (q) => q.exec(`update content_jobs set qline_state='failed', external_status='failed' where id=$1`, [other.id]));
    const r = await call(A, 'POST', `/content/jobs/${other.id}/reissue`, { revision: 1 });
    expect(r.json).toMatchObject({ revision: 2, state: 'prepared', externalStatus: null });
  });

  it('cancel needs confirmation, is final and is recorded', async () => {
    expect((await call(A, 'POST', `/content/jobs/${job.id}/cancel`, {})).status).toBe(400);
    expect((await call(A, 'POST', `/content/jobs/${job.id}/cancel`, { confirm: false })).status).toBe(400);
    const r = await call(M, 'POST', `/content/jobs/${job.id}/cancel`, { confirm: true, reason: 'Client changed plans' });
    expect(r.json).toMatchObject({ state: 'cancelled', cancelReason: 'Client changed plans' });
    expect((await call(A, 'POST', `/content/jobs/${job.id}/cancel`, { confirm: true })).json.code).toBe('JOB_CLOSED');
    expect((await call(A, 'POST', `/content/jobs/${job.id}/reissue`, { revision: 2 })).json.code).toBe('CANNOT_REISSUE');
    expect((await call(A, 'GET', '/content/jobs?filter=active')).json.items.map((j: any) => j.id)).not.toContain(job.id);
    expect((await call(A, 'GET', '/content/jobs?filter=all')).json.items.map((j: any) => j.id)).toContain(job.id);
    const det = (await call(A, 'GET', `/content/jobs/${job.id}`)).json;
    expect(det.events.map((e: any) => e.event_key)).toEqual(['created:r1', 'reissued:r2', 'cancelled']);
  });

  it('job history is append-only for the app and jobs cannot be deleted', async () => {
    await expect(asOrg(A, (q) => q.exec('update content_job_events set message=$1', ['x']))).rejects.toThrow(/permission denied/);
    await expect(asOrg(A, (q) => q.exec('delete from content_job_events'))).rejects.toThrow(/permission denied/);
    await expect(asOrg(A, (q) => q.exec('delete from content_jobs'))).rejects.toThrow(/permission denied/);
    await expect(asOrg(A, (q) => q.exec('delete from content_job_acks'))).rejects.toThrow(/permission denied/);
    await expect(asOrg(A, (q) => q.exec('update content_job_acks set status=$1', ['accepted']))).rejects.toThrow(/permission denied/);
  });

  it('a stored file that no longer matches its checksum is refused', async () => {
    const j = (await call(A, 'POST', '/content/jobs', JOB)).json;
    await asOrg(A, (q) => q.exec(`update content_jobs set manifest_json = manifest_json || ' ', pdf = pdf || '\\x00'::bytea where id=$1`, [j.id]));
    for (const what of ['manifest', 'pdf']) {
      const r = await call(A, 'GET', `/content/jobs/${j.id}/${what}`);
      expect(r.status, what).toBe(500);
      expect(r.json.code).toBe('INTEGRITY_FAILED');
    }
  });

  it('another organization sees nothing; permissions are enforced', async () => {
    expect((await call(B, 'GET', `/content/jobs/${job.id}`)).status).toBe(404);
    expect((await call(B, 'GET', `/content/jobs/${job.id}/manifest`)).status).toBe(404);
    expect((await call(B, 'GET', `/content/jobs/${job.id}/pdf`)).status).toBe(404);
    expect((await call(B, 'POST', `/content/jobs/${job.id}/cancel`, { confirm: true })).status).toBe(404);
    expect((await call(B, 'GET', '/content/jobs?filter=all')).json.items.length).toBe(0);
    expect((await call(B, 'POST', '/content/jobs', JOB)).json.code).toBe('NOT_CONFIGURED');
    const leaked = await asOrg(B, (q) => q.many('select 1 from content_jobs union all select 1 from content_job_events'));
    expect(leaked.length).toBe(0);
    expect((await call(null, 'GET', '/content/jobs')).status).toBe(401);
  });

  it('every job change is audited', async () => {
    const rows = await asOrg(A, (q) => q.many(`select action from audit_events where action like 'content.job.%'`));
    const actions = new Set(rows.map((r: any) => r.action));
    for (const a of ['content.job.create', 'content.job.reissue', 'content.job.cancel']) expect(actions.has(a), a).toBe(true);
  });

  it('"AI CEO" becomes "Command Center" for new and default-named agents only; the template key stays ceo', async () => {
    const ceo = (w: Who) => asOrg(w, (q) => q.one(`select id, name, template from agents where template='ceo'`));
    expect((await ceo(A)).name).toBe('Command Center'); // new organizations
    await asOrg(A, (q) => q.exec(`update agents set name='AI CEO' where template='ceo'`));
    await asOrg(B, (q) => q.exec(`update agents set name='Boss' where template='ceo'`));
    const sql = readFileSync(new URL('../../../packages/schema/migrations/0022_command_center_label.sql', import.meta.url), 'utf8');
    await asOrg(A, (q) => q.exec(sql));
    await asOrg(B, (q) => q.exec(sql));
    expect(await ceo(A)).toMatchObject({ name: 'Command Center', template: 'ceo' });
    expect(await ceo(B)).toMatchObject({ name: 'Boss', template: 'ceo' });
  });
});
