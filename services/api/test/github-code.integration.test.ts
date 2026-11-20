/**
 * v1.10 GitHub expansion (docs/24): code, branches, commits, pull requests and CI, against a real Postgres as the
 * app role (RLS enforced). GitHub is replaced by an in-memory fake repository behind a fetch stub, so these prove
 * Qline's own logic (staging, pinning, guards, approvals, routes, isolation). The same REST calls were also run
 * against real GitHub; see docs/24 §9. Needs QLINE_TEST_ENV; skipped otherwise.
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
let ai: typeof import('@qline/ai');

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
  return { status: res.status, json, text };
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

const asOrg = <T>(w: Who, fn: (q: import('../src/core/db').Q) => Promise<T>) => db.withTenant({ orgId: w.org!, userId: w.userId! }, fn);
const ctx = (w: Who) => ({ orgId: w.org!, workspaceId: w.ws!, actor: { kind: 'agent' as const, id: 'test-agent' }, userId: w.userId!, interactive: true });
const stage = (w: Who, name: string, args: unknown) => asOrg(w, (q) => tools.getTool(name)!.stage!(q, ctx(w), tools.getTool(name)!.schema.parse(args)));
const exec = (w: Who, name: string, args: unknown) => asOrg(w, (q) => tools.getTool(name)!.execute(q, ctx(w), args as any));
const run = (w: Who, name: string, args: unknown) => exec(w, name, tools.getTool(name)!.schema.parse(args));

const connect = (w: Who, token = 'ghu_test_token_for_qline_tests_000000') =>
  asOrg(w, (q) =>
    q.exec(
      `insert into integration_connections (org_id, workspace_id, provider, account_name, scopes, token_ciphertext, status, connected_by) values ($1,$2,'github','mara','{}',$3,'ok',$4)
       on conflict (org_id, provider) do update set token_ciphertext=excluded.token_ciphertext, status='ok'`,
      [w.org, w.ws, oauth.sealTokens(w.org!, 'github', { access_token: token }), w.userId],
    ),
  );

// ---- A tiny fake GitHub: one repo, branches as refs, files per commit ---------------------------
type Commit = { sha: string; tree: Record<string, { content: string; mode: string }>; parent: string | null; message: string };
const R = 'mara/shop';
let commits: Map<string, Commit>;
let refs: Map<string, string>;
let protectedBranches: Set<string>;
let posted: { url: string; method: string; body: any }[];
let pulls: any[];
let reviews: any[];
let forbid: RegExp | null;
let seq = 0;
const sha = () => (++seq).toString(16).padStart(40, 'a');
const realFetch = globalThis.fetch;

function reset() {
  seq = 0;
  const root = sha();
  commits = new Map([[root, { sha: root, parent: null, message: 'init', tree: { 'src/app.ts': { content: "export const VERSION = '0.1.0';\nexport const name = 'shop';\n", mode: '100644' }, 'scripts/build.sh': { content: '#!/bin/sh\necho build\n', mode: '100755' }, 'img/logo.png': { content: '\u0000PNG', mode: '100644' }, 'config/keys.ts': { content: "export const stripe = '" + 'sk_' + 'live_abcdefghijklmnopqrstuvwx' + "';\n", mode: '100644' } } }]]);
  refs = new Map([['main', root], ['qline/work', root], ['release', root]]);
  protectedBranches = new Set(['release']);
  posted = [];
  pulls = [];
  reviews = [];
  forbid = null;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const resolve = (ref: string | null) => (ref == null ? refs.get('main')! : refs.get(ref) ?? (commits.has(ref) ? ref : null));

function fakeGithub() {
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.host !== 'api.github.com') return realFetch(input, init);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') posted.push({ url: url.pathname, method, body });
    const p = decodeURIComponent(url.pathname);
    if (forbid?.test(`${method} ${p}`)) return json(403, { message: 'Resource not accessible by integration' });
    if (p === '/user/installations') return json(200, { installations: [{ id: 9, account: { login: 'mara', type: 'User' }, repository_selection: 'selected', permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', actions: 'read', checks: 'read', issues: 'write', secrets: 'read' } }] });
    if (!p.startsWith(`/repos/${R}`)) return json(404, { message: 'Not Found' });
    const rest = p.slice(`/repos/${R}`.length);
    if (rest === '' && method === 'GET') return json(200, { full_name: R, private: true, default_branch: 'main', archived: false, permissions: { push: true } });
    let m;
    if ((m = rest.match(/^\/branches\/(.+)$/))) {
      const s = refs.get(m[1]!);
      return s ? json(200, { name: m[1], commit: { sha: s }, protected: protectedBranches.has(m[1]!) }) : json(404, { message: 'Branch not found' });
    }
    if (rest === '/branches') return json(200, [...refs].map(([name, s]) => ({ name, commit: { sha: s }, protected: protectedBranches.has(name) })));
    if ((m = rest.match(/^\/contents\/?(.*)$/)) && method === 'GET') {
      const c = commits.get(resolve(url.searchParams.get('ref'))!);
      if (!c) return json(404, { message: 'No commit found for the ref' });
      const path = m[1]!;
      const f = c.tree[path];
      if (f) return json(200, { type: 'file', path, sha: `blob-${path}`, size: f.content.length, encoding: 'base64', content: Buffer.from(f.content).toString('base64'), html_url: `https://github.com/${R}/blob/x/${path}` });
      const kids = Object.keys(c.tree).filter((k) => (path ? k.startsWith(`${path}/`) : true));
      if (!kids.length) return json(404, { message: 'Not Found' });
      const names = new Map<string, string>();
      for (const k of kids) {
        const restPath = path ? k.slice(path.length + 1) : k;
        const [first, ...more] = restPath.split('/');
        names.set(first!, more.length ? 'dir' : 'file');
      }
      return json(200, [...names].map(([name, type]) => ({ name, type, path: path ? `${path}/${name}` : name, size: 1, sha: 'x' })));
    }
    if ((m = rest.match(/^\/git\/trees\/(.+)$/)) && method === 'GET') {
      // Commit sha → root tree; "<sha>:<dir>" style ids for sub-trees.
      const [cs, dir = ''] = m[1]!.split('::');
      const c = commits.get(cs!)!;
      const kids = Object.keys(c.tree).filter((k) => (dir ? k.startsWith(`${dir}/`) : true));
      const seen = new Map<string, any>();
      for (const k of kids) {
        const restPath = dir ? k.slice(dir.length + 1) : k;
        const [first, ...more] = restPath.split('/');
        seen.set(first!, more.length ? { path: first, type: 'tree', mode: '040000', sha: `${cs}::${dir ? `${dir}/` : ''}${first}` } : { path: first, type: 'blob', mode: c.tree[k]!.mode, sha: 'b' });
      }
      return json(200, { tree: [...seen.values()] });
    }
    if ((m = rest.match(/^\/git\/commits\/(.+)$/)) && method === 'GET') return commits.has(m[1]!) ? json(200, { sha: m[1], tree: { sha: `tree-${m[1]}` } }) : json(404, { message: 'Not Found' });
    if (rest === '/git/refs' && method === 'POST') {
      const name = body.ref.replace('refs/heads/', '');
      if (refs.has(name)) return json(422, { message: 'Reference already exists' });
      refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (rest === '/git/blobs' && method === 'POST') return json(201, { sha: `blob:${Buffer.from(body.content).toString('base64')}` });
    if (rest === '/git/trees' && method === 'POST') return json(201, { sha: `newtree:${Buffer.from(JSON.stringify(body)).toString('base64')}` });
    if (rest === '/git/commits' && method === 'POST') {
      const parent = commits.get(body.parents[0])!;
      const t = JSON.parse(Buffer.from(String(body.tree).slice('newtree:'.length), 'base64').toString());
      const tree = { ...parent.tree };
      for (const e of t.tree) tree[e.path] = { content: Buffer.from(String(e.sha).slice('blob:'.length), 'base64').toString(), mode: e.mode };
      const c = { sha: sha(), parent: parent.sha, message: body.message, tree };
      commits.set(c.sha, c);
      return json(201, { sha: c.sha });
    }
    if ((m = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const cur = refs.get(m[1]!);
      if (!cur) return json(422, { message: 'Reference does not exist' });
      if (!body.force && commits.get(body.sha)?.parent !== cur) return json(422, { message: 'Update is not a fast forward' });
      refs.set(m[1]!, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    if ((m = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      const base = resolve(m[1]!)!;
      const head = resolve(m[2]!)!;
      const chain: Commit[] = [];
      for (let c = commits.get(head); c && c.sha !== base; c = c.parent ? commits.get(c.parent) : undefined) chain.unshift(c);
      const files = Object.keys(commits.get(head)!.tree).filter((k) => commits.get(head)!.tree[k]!.content !== commits.get(base)!.tree[k]?.content);
      return json(200, { status: chain.length ? 'ahead' : 'identical', ahead_by: chain.length, behind_by: 0, total_commits: chain.length, commits: chain.map((c) => ({ sha: c.sha, commit: { message: c.message } })), files: files.map((f) => ({ filename: f, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' })) });
    }
    if (rest === '/pulls' && method === 'POST') {
      const pr = { number: pulls.length + 1, title: body.title, body: body.body, state: 'open', draft: body.draft, head: { ref: body.head, sha: refs.get(body.head) }, base: { ref: body.base }, html_url: `https://github.com/${R}/pull/${pulls.length + 1}`, user: { login: 'mara' } };
      pulls.push(pr);
      return json(201, pr);
    }
    if ((m = rest.match(/^\/pulls\/(\d+)$/))) {
      const pr = pulls[Number(m[1]) - 1];
      if (!pr) return json(404, { message: 'Not Found' });
      pr.head.sha = refs.get(pr.head.ref);
      if (method === 'PATCH') Object.assign(pr, body.base ? { ...body, base: { ref: body.base } } : body);
      return json(200, pr);
    }
    if ((m = rest.match(/^\/pulls\/(\d+)\/files/))) return json(200, [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@' }]);
    if ((m = rest.match(/^\/pulls\/(\d+)\/reviews/))) {
      if (method === 'POST') {
        reviews.push(body);
        return json(200, { id: 77, state: body.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED', html_url: 'https://github.com/r' });
      }
      return json(200, reviews.map((r) => ({ user: { login: 'mara' }, state: r.event, body: r.body })));
    }
    if ((m = rest.match(/^\/commits\/([^/]+)\/check-runs/))) return json(200, { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: 'x' }] });
    if ((m = rest.match(/^\/commits\/([^/]+)\/status/))) return json(200, { statuses: [] });
    if (rest === '/actions/runs') return json(200, { total_count: 1, workflow_runs: [{ id: 5, name: 'CI', display_title: 'Fix', event: 'push', head_branch: 'main', head_sha: 'abcdef1234', status: 'completed', conclusion: 'failure', run_attempt: 1, html_url: 'x' }] });
    if (rest === '/actions/runs/5') return json(200, { id: 5, name: 'CI', head_sha: 'abcdef1234', status: 'completed', conclusion: 'failure' });
    if (rest.startsWith('/actions/runs/5/jobs')) return json(200, { jobs: [{ id: 51, name: 'test', status: 'completed', conclusion: 'failure', steps: [{ number: 1, name: 'npm test', status: 'completed', conclusion: 'failure' }] }] });
    if (rest === '/actions/jobs/51/logs') return new Response('2026-11-20T05:00:00.0000000Z \u001b[31mFAIL\u001b[0m src/app.test.ts\n2026-11-20T05:00:01.0000000Z leaked ' + 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123456789' + '\n2026-11-20T05:00:02.0000000Z exit 1', { status: 200 });
    return json(404, { message: `fake github: ${method} ${rest}` });
  }) as typeof fetch;
}

d('v1.10 GitHub code, pull requests and CI (integration)', () => {
  let A: Who;
  let B: Who;
  let V: Who; // a viewer in org A
  beforeAll(async () => {
    app = (await import('../src/index')).default as any;
    db = await import('../src/core/db');
    tools = await import('../src/agent/tools');
    oauth = await import('../src/integrations/oauth');
    ai = await import('@qline/ai');
    A = await setup('Mara');
    B = await setup('Tomas');
    V = await signUp('Vic');
    const inv = await call(A, 'POST', '/invitations', { role: 'viewer' });
    expect((await call({ token: V.token }, 'POST', '/invitations/accept', { code: inv.json.code })).status).toBe(200);
    V.org = A.org;
    V.userId = (await call(V, 'GET', '/me')).json.user.id;
    V.ws = A.ws;
    await connect(A);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    ai.setTestProvider(null);
  });
  afterAll(async () => {
    await db.closePool();
  });

  it('reads code, branches, commits, pull requests and CI; masks secrets; keeps the token out of results', async () => {
    reset();
    fakeGithub();
    const repo = await run(A, 'github.repo', { repo: R });
    expect(repo).toMatchObject({ ok: true, data: expect.objectContaining({ defaultBranch: 'main' }) });
    const tree = await run(A, 'github.tree', { repo: R });
    expect((tree.data as any).entries.map((e: any) => `${e.type}:${e.name}`)).toEqual(['dir:config', 'dir:img', 'dir:scripts', 'dir:src']);
    const f = await run(A, 'github.file', { repo: R, path: 'src/app.ts' });
    expect((f.data as any).text).toContain("VERSION = '0.1.0'");
    const secret = await run(A, 'github.file', { repo: R, path: 'config/keys.ts' });
    expect((secret.data as any).text).toBe("export const stripe = '[redacted]';\n");
    expect((secret.data as any).note).toMatch(/1 secret-looking value was hidden/);
    expect(((await run(A, 'github.file', { repo: R, path: 'img/logo.png' })).data as any).note).toMatch(/binary/);
    expect((await run(A, 'github.file', { repo: R, path: '../etc/passwd' })).summary).toMatch(/cannot contain/);
    const br = await run(A, 'github.branches', { repo: R });
    expect((br.data as any).branches).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'release', protected: true }), expect.objectContaining({ name: 'main', default: true })]));
    const runs = await run(A, 'github.runs', { repo: R });
    expect((runs.data as any).runs[0]).toMatchObject({ id: 5, conclusion: 'failure' });
    const r = await run(A, 'github.run', { repo: R, runId: 5 });
    const job = (r.data as any).jobs[0];
    expect(job.failedSteps).toEqual(['npm test']);
    expect(job.logTail).toBe('FAIL src/app.test.ts\nleaked [redacted]\nexit 1');
    expect((await run(A, 'github.checks', { repo: R, ref: 'main' })).summary).toMatch(/failing/);
    expect(JSON.stringify([repo, tree, f, br, runs, r])).not.toContain('ghu_test_token');
  });

  it('names the missing GitHub App permission on "Resource not accessible by integration"', async () => {
    reset();
    fakeGithub();
    forbid = /actions\/runs/;
    const r = await run(A, 'github.runs', { repo: R });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/does not have the Actions \(read\) permission/);
  });

  it('stages a commit with a pinned head and a diff; refuses the default branch, protected branches, workflows and secrets', async () => {
    reset();
    fakeGithub();
    const next = "export const VERSION = '0.2.0';\nexport const name = 'shop';\n";
    const s = await stage(A, 'github.files.commit', { repo: R, branch: 'qline/work', message: 'Bump version', files: [{ path: 'src/app.ts', content: next }, { path: 'scripts/build.sh', content: '#!/bin/sh\necho v2\n' }], _pinned: { headSha: 'f'.repeat(40) } });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const pin = (s.args as any)._pinned;
    expect(pin.headSha).toBe(refs.get('qline/work')); // the model's forged pin is gone
    expect(pin.files).toEqual([{ path: 'src/app.ts', mode: '100644', existed: true }, { path: 'scripts/build.sh', mode: '100755', existed: true }]);
    expect(s.preview.diff).toContain("-export const VERSION = '0.1.0';\n+export const VERSION = '0.2.0';");
    expect(s.preview.lines).toEqual(expect.arrayContaining(['Change src/app.ts', '+2 −2 lines']));
    expect(posted).toEqual([]); // staging only reads
    const refuse = async (args: any, re: RegExp) => {
      const x = await stage(A, 'github.files.commit', { repo: R, message: 'x', files: [{ path: 'src/app.ts', content: next }], ...args });
      expect(x.ok).toBe(false);
      expect((x as any).error).toMatch(re);
    };
    await refuse({ branch: 'main' }, /never writes to the default branch/);
    await refuse({ branch: 'release' }, /protected branch/);
    await refuse({ branch: 'qline/work', files: [{ path: '.github/workflows/ci.yml', content: 'on: push' }] }, /does not change GitHub Actions workflows/);
    await refuse({ branch: 'qline/work', files: [{ path: '.env', content: 'A=1' }] }, /usually hold secrets/);
    await refuse({ branch: 'qline/work', files: [{ path: 'src/k.ts', content: "const k = '" + 'gh' + "p_abcdefghijklmnopqrstuvwxyz0123456789';" }] }, /looks like a secret/);
    await refuse({ branch: 'qline/work', files: [{ path: 'config/keys.ts', content: "export const stripe = '[redacted]';\n" }] }, /\[redacted\]/);
    await refuse({ branch: 'qline/work', files: [{ path: 'src/app.ts', content: "export const VERSION = '0.1.0';\nexport const name = 'shop';\n" }] }, /would not change/);
    await refuse({ branch: 'nope/missing' }, /no branch nope\/missing.*createFrom/);
    expect(posted).toEqual([]);
  });

  it('executes only the staged commit: no pin → nothing; moved branch → nothing; otherwise one fast-forward commit', async () => {
    reset();
    fakeGithub();
    const next = "export const VERSION = '0.2.0';\nexport const name = 'shop';\n";
    const args = { repo: R, branch: 'qline/work', message: 'Bump version', files: [{ path: 'src/app.ts', content: next }, { path: 'scripts/build.sh', content: '#!/bin/sh\necho v2\n' }] };
    expect((await run(A, 'github.files.commit', args)).summary).toMatch(/not reviewed in Approvals/);
    expect(posted).toEqual([]);
    const s = await stage(A, 'github.files.commit', args);
    if (!s.ok) throw new Error((s as any).error);
    // Someone pushes to the branch after the approval was created.
    const moved = sha();
    commits.set(moved, { ...commits.get(refs.get('qline/work')!)!, sha: moved, parent: refs.get('qline/work')! });
    const old = refs.get('qline/work')!;
    refs.set('qline/work', moved);
    const stale = await exec(A, 'github.files.commit', s.args);
    expect(stale.ok).toBe(false);
    expect(stale.summary).toMatch(/changed since this was approved/);
    expect(posted).toEqual([]);
    refs.set('qline/work', old);
    const ok = await exec(A, 'github.files.commit', s.args);
    expect(ok.ok).toBe(true);
    const head = commits.get(refs.get('qline/work')!)!;
    expect(head.parent).toBe(old);
    expect(head.tree['src/app.ts']!.content).toBe(next);
    expect(head.tree['scripts/build.sh']!.mode).toBe('100755');
    expect(refs.get('main')).toBe(old); // main untouched
    const patch = posted.find((p) => p.method === 'PATCH')!;
    expect(patch).toMatchObject({ url: `/repos/${R}/git/refs/heads/qline/work`, body: { force: false } });
    expect(posted.every((p) => !/\/merge|\/actions\/secrets|DELETE/.test(`${p.method} ${p.url}`))).toBe(true);
    const a = await asOrg(A, (q) => q.one(`select detail from audit_events where action='github.files_committed' order by at desc limit 1`));
    expect(a.detail).toMatchObject({ files: ['src/app.ts', 'scripts/build.sh'], parent: old, createdBranch: false });
  });

  it('creates the working branch in the same approved commit when asked, from the pinned base', async () => {
    reset();
    fakeGithub();
    const s = await stage(A, 'github.files.commit', { repo: R, branch: 'qline/new-docs', createFrom: 'main', message: 'Add docs', files: [{ path: 'docs/readme.md', content: '# Shop\n' }] });
    if (!s.ok) throw new Error((s as any).error);
    expect((s.args as any)._pinned).toMatchObject({ headSha: null, baseSha: refs.get('main'), createBranch: true, files: [{ path: 'docs/readme.md', mode: '100644', existed: false }] });
    expect(s.preview.diff).toContain('--- /dev/null\n+++ b/docs/readme.md');
    const r = await exec(A, 'github.files.commit', s.args);
    expect(r.ok).toBe(true);
    expect(commits.get(refs.get('qline/new-docs')!)!.tree['docs/readme.md']!.content).toBe('# Shop\n');
    // Staging again now that it exists refuses a second "create"; a forged createBranch on an existing branch is refused at run time.
    expect((await exec(A, 'github.files.commit', s.args)).summary).toMatch(/was created after this was approved/);
  });

  it('opens a draft PR, edits it, and reviews only the commit that was approved; there is no approve or merge', async () => {
    reset();
    fakeGithub();
    const c = await stage(A, 'github.files.commit', { repo: R, branch: 'qline/work', message: 'Bump', files: [{ path: 'src/app.ts', content: 'x\n' }] });
    if (!c.ok) throw new Error('stage');
    expect((await exec(A, 'github.files.commit', c.args)).ok).toBe(true);
    const pr = await stage(A, 'github.pr.create', { repo: R, head: 'qline/work', title: 'Bump version', body: 'Why', draft: true });
    if (!pr.ok) throw new Error((pr as any).error);
    expect(pr.args).toMatchObject({ base: 'main', _pinned: { base: 'main', headSha: refs.get('qline/work') } });
    expect(pr.preview.diff).toContain('+++ b/src/app.ts');
    expect((await stage(A, 'github.pr.create', { repo: R, head: 'main', base: 'release', title: 'x' })).ok).toBe(false);
    const opened = await exec(A, 'github.pr.create', pr.args);
    expect(opened).toMatchObject({ ok: true, data: expect.objectContaining({ number: 1, draft: true }) });
    const up = await stage(A, 'github.pr.update', { repo: R, number: 1, title: 'Bump to 0.2.0', body: 'Why\nAnd how' });
    if (!up.ok) throw new Error('update');
    expect(up.preview.lines).toContain('Title: “Bump version” → “Bump to 0.2.0”');
    expect(up.preview.diff).toContain('+And how');
    expect((await exec(A, 'github.pr.update', up.args)).ok).toBe(true);
    expect(pulls[0].title).toBe('Bump to 0.2.0');
    expect(() => tools.getTool('github.pr.review')!.schema.parse({ repo: R, number: 1, event: 'APPROVE', body: 'lgtm' })).toThrow();
    const rv = await stage(A, 'github.pr.review', { repo: R, number: 1, event: 'REQUEST_CHANGES', body: 'Please add a test', comments: [{ path: 'src/app.ts', line: 1, body: 'here' }] });
    if (!rv.ok) throw new Error('review');
    expect((await stage(A, 'github.pr.review', { repo: R, number: 1, event: 'COMMENT', body: 'x', comments: [{ path: 'nope.ts', line: 1, body: 'x' }] })).ok).toBe(false);
    // New commits after approval → the review is not posted.
    const before = refs.get('qline/work')!;
    const n = sha();
    commits.set(n, { ...commits.get(before)!, sha: n, parent: before });
    refs.set('qline/work', n);
    expect((await exec(A, 'github.pr.review', rv.args)).summary).toMatch(/got new commits/);
    refs.set('qline/work', before);
    expect((await exec(A, 'github.pr.review', rv.args)).ok).toBe(true);
    expect(reviews[0]).toMatchObject({ event: 'REQUEST_CHANGES', commit_id: before, comments: [{ path: 'src/app.ts', line: 1, side: 'RIGHT', body: 'here' }] });
    expect(posted.some((p) => /merge/.test(p.url))).toBe(false);
  });

  it('through the chat: a commit always waits for approval (even on full autopilot) with the diff, then runs as approved', async () => {
    reset();
    fakeGithub();
    const { seal } = await import('../src/core/secrets');
    const { aad } = await import('../src/agent/models');
    await asOrg(A, (q) => q.exec(`insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, models, created_by) values ($1,'anthropic',$2,'TEST',$3,'test') on conflict do nothing`, [A.org, seal('sk-ant-test-key', aad(A.org!, 'anthropic')), JSON.stringify([{ id: 'claude-test', name: 'Claude Test' }])]));
    expect((await call(A, 'PUT', '/ai/default', { provider: 'anthropic', model: 'claude-test' })).status).toBe(200);
    expect((await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'full', dailyExternalLimit: 25 })).status).toBe(200);
    const forged = { headSha: 'f'.repeat(40), files: [{ path: 'src/app.ts', mode: '100755', existed: true }] };
    ai.setTestProvider(
      new ai.MockProvider((req) =>
        !req.messages.some((m) => m.role === 'tool')
          ? [{ type: 'tool_call', call: { id: randomUUID(), type: 'function', function: { name: 'github__files__commit', arguments: JSON.stringify({ repo: R, branch: 'qline/work', message: 'Bump', files: [{ path: 'src/app.ts', content: 'v2\n' }], _pinned: forged }) } } }, { type: 'done' }]
          : [{ type: 'token', text: 'Waiting for your approval.' }, { type: 'done' }],
      ),
    );
    const conv = await call(A, 'POST', '/conversations', {});
    const m = await call(A, 'POST', `/conversations/${conv.json.id}/messages`, { content: 'Bump the version in mara/shop' });
    expect(m.status).toBe(202);
    const sse = await (await app.fetch(new Request(`http://localhost/v1/runs/${m.json.runId}/stream`, { headers: { authorization: `Bearer ${A.token}`, 'x-qline-org': A.org! } }))).text();
    expect(sse).toContain('approval.required');
    expect(posted).toEqual([]);
    const tc = await asOrg(A, (q) => q.one(`select id, status, args from tool_calls where run_id=$1 and tool='github.files.commit'`, [m.json.runId]));
    expect(tc.status).toBe('waiting_approval');
    expect(tc.args._pinned.headSha).toBe(refs.get('qline/work'));
    expect(tc.args._pinned.files[0].mode).toBe('100644');
    const ap = await asOrg(A, (q) => q.one(`select id from approval_requests where tool_call_id=$1`, [tc.id]));
    const detail = await call(A, 'GET', `/approvals/${ap.id}`);
    const preview = detail.json.preview ?? detail.json.approval?.preview;
    expect(JSON.stringify(preview)).toContain('+v2');
    expect(JSON.stringify(preview)).toContain('[3 characters, shown in the diff]');
    // A viewer cannot decide it; the owner approves and exactly that commit is made.
    expect((await call(V, 'POST', `/approvals/${ap.id}/decision`, { decision: 'approve' })).status).toBe(403);
    const dec = await call(A, 'POST', `/approvals/${ap.id}/decision`, { decision: 'approve' });
    expect(dec.status).toBe(200);
    expect(commits.get(refs.get('qline/work')!)!.tree['src/app.ts']).toEqual({ content: 'v2\n', mode: '100644' });
    expect(refs.get('main')).not.toBe(refs.get('qline/work'));
    await call(A, 'PUT', `/workspaces/${A.ws}/autonomy`, { autonomy: 'supervised' });
  });

  it('routes: capabilities and read-only browsing for this organization only', async () => {
    reset();
    fakeGithub();
    const cap = await call(A, 'GET', '/github/capabilities');
    expect(cap.status).toBe(200);
    expect(cap.json.capabilities.find((x: any) => x.id === 'write')).toMatchObject({ granted: true, accounts: ['mara'] });
    expect(cap.json.capabilities.find((x: any) => x.id === 'statuses')).toMatchObject({ granted: false });
    expect(cap.json.installations[0].unusedRisky).toEqual(['secrets']);
    expect((await call(V, 'GET', `/github/repos/${R}/tree?path=src`)).json.entries).toEqual([expect.objectContaining({ name: 'app.ts' })]);
    expect((await call(V, 'GET', `/github/repos/${R}/file?path=src/app.ts`)).json.text).toContain('VERSION');
    expect((await call(V, 'GET', `/github/repos/${R}/branches`)).json.defaultBranch).toBe('main');
    expect((await call(V, 'GET', `/github/repos/${R}/runs/5`)).json.jobs[0].failedSteps).toEqual(['npm test']);
    expect((await call(A, 'GET', `/github/repos/${R}/file?path=..%2Fx`)).status).toBe(400);
    // Another organization has no GitHub connection and cannot use A's.
    const b = await call(B, 'GET', '/github/repos');
    expect(b.status).toBe(409);
    expect(b.json.error?.message ?? b.text).toMatch(/not connected/);
    expect((await call(null, 'GET', '/github/repos')).status).toBe(401);
    // No write routes exist.
    expect((await call(A, 'POST', `/github/repos/${R}/commits`, {})).status).toBe(404);
  });
});
