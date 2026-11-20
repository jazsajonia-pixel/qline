import { PROVIDER_TIMEOUT_MS } from './oauth';
import { noteRequest } from '../core/external';
import { ProviderHttpError, REPO } from './connectors';

/**
 * v1.10 GitHub expansion (docs/24): code browsing, branches, commits, pull requests and CI over the GitHub REST API,
 * with the person's GitHub App user token. What the token may do is decided by the Qline GitHub App's permissions
 * and the repositories it is installed on; Qline adds its own floor on top (see the write guards below).
 *
 * Never here: merging, force-pushing, deleting branches, changing workflows, or reading Actions secrets/variables.
 */

const GH = 'https://api.github.com';
const headers = (token: string, accept = 'application/vnd.github+json') => ({
  authorization: `Bearer ${token}`,
  accept,
  'x-github-api-version': '2022-11-28',
  'user-agent': 'Qline',
});

const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

/** Secret-looking values are masked in anything Qline reads back (file contents, logs, patches). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(ya29\.[A-Za-z0-9._-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|[sr]k_(live|test)_[A-Za-z0-9]{10,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{30,})\b/g,
];
export function redactSecrets(s: string): { text: string; redacted: number } {
  let n = 0;
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, () => (n++, '[redacted]'));
  return { text: out, redacted: n };
}
export const looksSecret = (s: string) => redactSecrets(s).redacted > 0;

async function gh(token: string, method: string, path: string, body?: unknown, opts: { accept?: string; raw?: boolean; timeoutMs?: number } = {}) {
  const url = path.startsWith('https://') ? path : `${GH}${path}`;
  const answered = noteRequest(method);
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: { ...headers(token, opts.accept), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
  } catch (e) {
    answered(null);
    throw e;
  }
  answered(r.status);
  if (opts.raw && r.ok) return r;
  const text = await r.text().catch(() => '');
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  if (!r.ok) {
    const msg = j?.message ?? `HTTP ${r.status}`;
    const err = new ProviderHttpError(String(msg).slice(0, 300), r.status);
    (err as any).accepted = r.headers.get('x-accepted-github-permissions');
    throw err;
  }
  return j;
}

/** Each path segment encoded on its own, so "feature/x" stays a path but nothing can escape it. */
export const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const repoPath = (repo: string) => {
  if (!REPO.test(repo)) throw new ProviderHttpError('Use owner/name for the repository.', 400);
  return `/repos/${repo}`;
};

// ---- Validation shared by tools and routes --------------------------------------------------------

/** A safe branch name: git's ref rules, minus anything unusual. */
export const BRANCH = /^(?!\/|.*\/\/|.*\/$|.*\.\.|.*@\{|.*\.lock$|.*\.$)[A-Za-z0-9._\/-]{1,200}$/;

/** A repository-relative file path. No absolute paths, no "." or ".." segments, no .git internals. */
export function badPath(p: string): string | null {
  if (!p || p.length > 400) return 'The path is empty or too long.';
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return 'Use a path inside the repository, like src/app.ts.';
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return 'The path cannot contain empty, "." or ".." parts.';
  if (segs.some((s) => s.toLowerCase() === '.git')) return 'Qline does not touch .git internals.';
  return null;
}

/**
 * Write floor (docs/24 §4): paths Qline never writes, whatever the GitHub App allows.
 * - .github/workflows and .github/actions: a workflow change can run code with the repository's secrets.
 * - .env files and key material: secrets do not belong in a repository.
 */
export function blockedWritePath(p: string): string | null {
  const low = p.toLowerCase();
  if (low.startsWith('.github/workflows/') || low.startsWith('.github/actions/') || low === '.github/workflows' || low === '.github/actions') {
    return 'Qline does not change GitHub Actions workflows: a workflow can use the repository\'s secrets. Edit workflows yourself.';
  }
  const base = low.split('/').pop()!;
  if (base === '.env' || base.startsWith('.env.') || /\.(pem|key|p12|pfx|keystore|jks)$/.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) || base === 'key.properties') {
    return `Qline does not write ${base}: files like this usually hold secrets.`;
  }
  return null;
}

// ---- Repositories and permissions ---------------------------------------------------------------

/** The installations this person's token can use, with what each one allows. */
export interface GithubInstallation {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, 'read' | 'write' | 'admin'>;
  suspended: boolean;
}
export async function githubInstallations(token: string): Promise<GithubInstallation[]> {
  const j = await gh(token, 'GET', '/user/installations?per_page=50');
  return (j.installations ?? []).map((i: any) => ({
    id: i.id as number,
    account: i.account?.login as string,
    accountType: i.account?.type as string,
    repositorySelection: i.repository_selection as 'all' | 'selected',
    permissions: (i.permissions ?? {}) as Record<string, 'read' | 'write' | 'admin'>,
    suspended: !!i.suspended_at,
  }));
}

/** Qline features → the GitHub App permission each needs (docs/24 §3). */
export const CAPABILITIES = [
  { id: 'browse', name: 'Browse repositories and read code', permission: 'contents', level: 'read' },
  { id: 'write', name: 'Create branches and commit files (with approval)', permission: 'contents', level: 'write' },
  { id: 'pulls_read', name: 'Read pull requests', permission: 'pull_requests', level: 'read' },
  { id: 'pulls_write', name: 'Open, edit and review pull requests (with approval)', permission: 'pull_requests', level: 'write' },
  { id: 'ci', name: 'Read CI: workflow runs, jobs and logs', permission: 'actions', level: 'read' },
  { id: 'checks', name: 'Read check runs', permission: 'checks', level: 'read' },
  { id: 'statuses', name: 'Read commit statuses', permission: 'statuses', level: 'read' },
  { id: 'issues_read', name: 'Read issues', permission: 'issues', level: 'read' },
  { id: 'issues_write', name: 'Open issues and comment (with approval)', permission: 'issues', level: 'write' },
] as const;

const rank = (l?: string) => (l === 'admin' ? 3 : l === 'write' ? 2 : l === 'read' ? 1 : 0);

export function capabilityReport(installs: GithubInstallation[]) {
  return CAPABILITIES.map((c) => {
    const where = installs.filter((i) => !i.suspended && rank(i.permissions[c.permission]) >= rank(c.level)).map((i) => i.account);
    return { id: c.id, name: c.name, permission: `${c.permission}:${c.level}`, granted: where.length > 0, accounts: where };
  });
}

/** Permissions the app has but Qline never uses (shown so the owner can remove them). */
export const UNUSED_RISKY = ['secrets', 'administration', 'workflows', 'environments', 'actions_variables', 'organization_secrets'];

export async function githubRepo(token: string, repo: string) {
  const r = await gh(token, 'GET', repoPath(repo));
  return {
    fullName: r.full_name as string,
    private: !!r.private,
    description: clip(r.description, 500),
    defaultBranch: r.default_branch as string,
    language: r.language ?? null,
    topics: r.topics ?? [],
    archived: !!r.archived,
    fork: !!r.fork,
    size: r.size,
    openIssues: r.open_issues_count,
    url: r.html_url as string,
    pushedAt: r.pushed_at,
    /** What this person may do in the repository (GitHub's own answer for the user). */
    permissions: r.permissions ?? null,
  };
}

// ---- Code ---------------------------------------------------------------------------------------

export async function githubTree(token: string, repo: string, opts: { ref?: string | null; path?: string | null }) {
  const p = (opts.path ?? '').replace(/^\/+|\/+$/g, '');
  if (p) {
    const bad = badPath(p);
    if (bad) throw new ProviderHttpError(bad, 400);
  }
  const q = opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : '';
  const j = await gh(token, 'GET', `${repoPath(repo)}/contents${p ? `/${encPath(p)}` : ''}${q}`);
  if (!Array.isArray(j)) throw new ProviderHttpError('That path is a file. Read it as a file instead.', 400);
  const entries = j
    .map((e: any) => ({ name: e.name as string, path: e.path as string, type: e.type as 'file' | 'dir' | 'symlink' | 'submodule', size: e.size as number, sha: e.sha as string }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : b.type === 'dir' ? 1 : a.name.localeCompare(b.name)));
  return { path: p, ref: opts.ref ?? null, entries: entries.slice(0, 500), truncated: entries.length > 500 };
}

export const FILE_READ_MAX = 1024 * 1024;
const LINES_PER_PAGE = 400;

/** Raw file at a ref (exists=false when it does not exist there). Text only; at most 1 MB. */
export async function githubFileRaw(token: string, repo: string, path: string, ref?: string | null) {
  const bad = badPath(path);
  if (bad) throw new ProviderHttpError(bad, 400);
  let meta: any;
  try {
    meta = await gh(token, 'GET', `${repoPath(repo)}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  } catch (e) {
    if (e instanceof ProviderHttpError && e.status === 404) return { exists: false as const };
    throw e;
  }
  if (Array.isArray(meta)) throw new ProviderHttpError('That path is a folder. List it instead.', 400);
  if (meta.type !== 'file') throw new ProviderHttpError(`That path is a ${meta.type}, not a file.`, 400);
  if (meta.size > FILE_READ_MAX) return { exists: true as const, sha: meta.sha as string, size: meta.size as number, tooBig: true, binary: false, text: '', url: meta.html_url as string };
  let bytes: Buffer;
  if (meta.content && meta.encoding === 'base64') bytes = Buffer.from(meta.content, 'base64');
  else {
    const r = (await gh(token, 'GET', `${repoPath(repo)}/contents/${encPath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`, undefined, { accept: 'application/vnd.github.raw+json', raw: true })) as Response;
    bytes = Buffer.from(await r.arrayBuffer());
  }
  const binary = bytes.subarray(0, 8000).includes(0);
  return { exists: true as const, sha: meta.sha as string, size: meta.size as number, tooBig: false, binary, text: binary ? '' : bytes.toString('utf8'), url: meta.html_url as string };
}

export async function githubFile(token: string, repo: string, path: string, opts: { ref?: string | null; page?: number }) {
  const f = await githubFileRaw(token, repo, path, opts.ref);
  if (!f.exists) throw new ProviderHttpError('That file does not exist at this branch or commit.', 404);
  if (f.tooBig) return { path, ref: opts.ref ?? null, sha: f.sha, size: f.size, url: f.url, note: 'This file is larger than 1 MB, so Qline does not read it. Open it on GitHub.', text: '', page: 1, pages: 1, lines: 0 };
  if (f.binary) return { path, ref: opts.ref ?? null, sha: f.sha, size: f.size, url: f.url, note: 'This is a binary file, so there is no text to show.', text: '', page: 1, pages: 1, lines: 0 };
  const { text, redacted } = redactSecrets(f.text);
  const lines = text.split('\n');
  const pages = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const start = (page - 1) * LINES_PER_PAGE;
  return {
    path,
    ref: opts.ref ?? null,
    sha: f.sha,
    size: f.size,
    url: f.url,
    page,
    pages,
    lines: lines.length,
    firstLine: start + 1,
    text: lines.slice(start, start + LINES_PER_PAGE).join('\n'),
    ...(redacted ? { note: `${redacted} secret-looking value${redacted === 1 ? ' was' : 's were'} hidden.` } : {}),
  };
}

/** Code search in one repository (GitHub searches the default branch only). */
export async function githubCodeSearch(token: string, repo: string, query: string, limit = 20) {
  if (!REPO.test(repo)) throw new ProviderHttpError('Use owner/name for the repository.', 400);
  const q = `${query.replace(/\brepo:\S+/g, '').trim()} repo:${repo}`;
  const j = await gh(token, 'GET', `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 50)}`, undefined, { accept: 'application/vnd.github.text-match+json' });
  return {
    total: j.total_count as number,
    items: (j.items ?? []).map((i: any) => ({
      path: i.path as string,
      url: i.html_url as string,
      matches: (i.text_matches ?? []).slice(0, 3).map((m: any) => redactSecrets(clip(m.fragment, 400)).text),
    })),
  };
}

// ---- Branches and commits -----------------------------------------------------------------------

export async function githubBranches(token: string, repo: string, opts: { query?: string | null; limit?: number }) {
  const [info, list] = await Promise.all([githubRepo(token, repo), gh(token, 'GET', `${repoPath(repo)}/branches?per_page=100`)]);
  const q = (opts.query ?? '').toLowerCase();
  const rows = (list ?? [])
    .filter((b: any) => !q || String(b.name).toLowerCase().includes(q))
    .slice(0, opts.limit ?? 50)
    .map((b: any) => ({ name: b.name as string, sha: b.commit?.sha as string, protected: !!b.protected, default: b.name === info.defaultBranch }));
  return { defaultBranch: info.defaultBranch, branches: rows };
}

export async function githubBranch(token: string, repo: string, branch: string) {
  const b = await gh(token, 'GET', `${repoPath(repo)}/branches/${encPath(branch)}`);
  return { name: b.name as string, sha: b.commit?.sha as string, protected: !!b.protected };
}

const commitRow = (c: any) => ({
  sha: c.sha as string,
  short: String(c.sha).slice(0, 7),
  message: clip(c.commit?.message, 300),
  author: c.author?.login ?? c.commit?.author?.name ?? null,
  date: c.commit?.author?.date ?? null,
  url: c.html_url as string,
});

export async function githubCommits(token: string, repo: string, opts: { ref?: string | null; path?: string | null; limit?: number }) {
  const p = new URLSearchParams({ per_page: String(Math.min(opts.limit ?? 20, 50)) });
  if (opts.ref) p.set('sha', opts.ref);
  if (opts.path) {
    const bad = badPath(opts.path);
    if (bad) throw new ProviderHttpError(bad, 400);
    p.set('path', opts.path);
  }
  const j = await gh(token, 'GET', `${repoPath(repo)}/commits?${p}`);
  return (j ?? []).map(commitRow);
}

const fileRow = (f: any, patchChars: number) => ({
  path: f.filename as string,
  status: f.status as string,
  additions: f.additions as number,
  deletions: f.deletions as number,
  ...(f.previous_filename ? { from: f.previous_filename } : {}),
  patch: f.patch ? redactSecrets(clip(f.patch, patchChars)).text : null,
});

export async function githubCommit(token: string, repo: string, sha: string) {
  const c = await gh(token, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}`);
  return {
    ...commitRow(c),
    message: clip(c.commit?.message, 4000),
    parents: (c.parents ?? []).map((p: any) => p.sha),
    stats: c.stats ?? null,
    files: (c.files ?? []).slice(0, 100).map((f: any) => fileRow(f, 3000)),
  };
}

export async function githubCompare(token: string, repo: string, base: string, head: string) {
  const c = await gh(token, 'GET', `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  return {
    status: c.status as string,
    aheadBy: c.ahead_by as number,
    behindBy: c.behind_by as number,
    totalCommits: c.total_commits as number,
    commits: (c.commits ?? []).slice(-30).map(commitRow),
    files: (c.files ?? []).slice(0, 100).map((f: any) => fileRow(f, 2000)),
    url: c.html_url as string,
  };
}

// ---- Pull requests ------------------------------------------------------------------------------

const prRow = (p: any) => ({
  number: p.number as number,
  title: clip(p.title, 300),
  state: p.merged_at ? 'merged' : (p.state as string),
  draft: !!p.draft,
  author: p.user?.login ?? null,
  head: p.head?.ref as string,
  base: p.base?.ref as string,
  updatedAt: p.updated_at,
  url: p.html_url as string,
});

export async function githubPulls(token: string, repo: string, opts: { state?: 'open' | 'closed' | 'all'; limit?: number }) {
  const j = await gh(token, 'GET', `${repoPath(repo)}/pulls?state=${opts.state ?? 'open'}&sort=updated&direction=desc&per_page=${Math.min(opts.limit ?? 20, 50)}`);
  return (j ?? []).map(prRow);
}

export async function githubPull(token: string, repo: string, number: number) {
  const base = `${repoPath(repo)}/pulls/${number}`;
  const p = await gh(token, 'GET', base);
  const [files, reviews, checks] = await Promise.all([
    gh(token, 'GET', `${base}/files?per_page=100`).catch(() => []),
    gh(token, 'GET', `${base}/reviews?per_page=50`).catch(() => []),
    githubChecks(token, repo, p.head?.sha).catch(() => null),
  ]);
  return {
    ...prRow(p),
    body: redactSecrets(clip(p.body, 6000)).text,
    headSha: p.head?.sha as string,
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? null,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    files: (files ?? []).slice(0, 100).map((f: any) => fileRow(f, 2000)),
    reviews: (reviews ?? []).slice(-20).map((r: any) => ({ author: r.user?.login, state: r.state, at: r.submitted_at, body: clip(r.body, 1000) })),
    checks,
  };
}

// ---- CI -----------------------------------------------------------------------------------------

export async function githubChecks(token: string, repo: string, ref: string) {
  const [runs, status] = await Promise.all([
    gh(token, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`).catch((e) => ({ error: e })),
    gh(token, 'GET', `${repoPath(repo)}/commits/${encodeURIComponent(ref)}/status`).catch((e) => ({ error: e })),
  ]);
  if ((runs as any).error && (status as any).error) throw (runs as any).error;
  const checkRuns = ((runs as any).check_runs ?? []).map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, app: c.app?.slug ?? null }));
  const statuses = ((status as any).statuses ?? []).map((s: any) => ({ context: s.context, state: s.state, description: clip(s.description, 200), url: s.target_url }));
  const failing = checkRuns.filter((c: any) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(c.conclusion)).length + statuses.filter((s: any) => ['failure', 'error'].includes(s.state)).length;
  const pending = checkRuns.filter((c: any) => c.status !== 'completed').length + statuses.filter((s: any) => s.state === 'pending').length;
  return { ref, overall: failing ? 'failing' : pending ? 'pending' : checkRuns.length + statuses.length ? 'passing' : 'none', checkRuns, statuses };
}

const runRow = (r: any) => ({
  id: r.id as number,
  name: r.name as string,
  title: clip(r.display_title, 200),
  event: r.event as string,
  branch: r.head_branch as string,
  sha: String(r.head_sha).slice(0, 7),
  status: r.status as string,
  conclusion: r.conclusion as string | null,
  attempt: r.run_attempt as number,
  createdAt: r.created_at,
  url: r.html_url as string,
});

export async function githubRuns(token: string, repo: string, opts: { branch?: string | null; status?: string | null; limit?: number }) {
  const p = new URLSearchParams({ per_page: String(Math.min(opts.limit ?? 15, 50)) });
  if (opts.branch) p.set('branch', opts.branch);
  if (opts.status) p.set('status', opts.status);
  const j = await gh(token, 'GET', `${repoPath(repo)}/actions/runs?${p}`);
  return { total: j.total_count as number, runs: (j.workflow_runs ?? []).map(runRow) };
}

/** One workflow run with its jobs; failed jobs come with the end of their log (secrets masked). */
export async function githubRun(token: string, repo: string, runId: number, opts: { logs?: boolean } = {}) {
  const r = await gh(token, 'GET', `${repoPath(repo)}/actions/runs/${runId}`);
  const jobs = await gh(token, 'GET', `${repoPath(repo)}/actions/runs/${runId}/jobs?per_page=50`);
  const rows = [] as any[];
  for (const j of jobs.jobs ?? []) {
    const failed = ['failure', 'timed_out', 'cancelled'].includes(j.conclusion);
    let logTail: string | null = null;
    if (failed && opts.logs !== false && rows.filter((x) => x.logTail).length < 3) logTail = await githubJobLogTail(token, repo, j.id).catch(() => null);
    rows.push({
      id: j.id as number,
      name: j.name as string,
      status: j.status,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      url: j.html_url,
      steps: (j.steps ?? []).map((s: any) => ({ number: s.number, name: s.name, status: s.status, conclusion: s.conclusion })),
      failedSteps: (j.steps ?? []).filter((s: any) => s.conclusion === 'failure').map((s: any) => s.name),
      ...(logTail != null ? { logTail } : {}),
    });
  }
  return { ...runRow(r), jobs: rows };
}

export async function githubJobLogTail(token: string, repo: string, jobId: number, lines = 120) {
  const res = (await gh(token, 'GET', `${repoPath(repo)}/actions/jobs/${jobId}/logs`, undefined, { raw: true, accept: 'application/vnd.github+json' })) as Response;
  const text = (await res.text()).slice(-200_000);
  const tail = text.split('\n').slice(-lines).map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')).join('\n');
  return redactSecrets(tail).text.slice(-12_000);
}

/** The git mode of one path at a commit (walks the trees; null when it is not there). */
export async function githubTreeEntryMode(token: string, repo: string, commitSha: string, path: string): Promise<string | null> {
  const segs = path.split('/');
  let tree = await gh(token, 'GET', `${repoPath(repo)}/git/trees/${encodeURIComponent(commitSha)}`);
  for (let i = 0; i < segs.length; i++) {
    const e = (tree.tree ?? []).find((x: any) => x.path === segs[i]);
    if (!e) return null;
    if (i === segs.length - 1) return e.mode as string;
    if (e.type !== 'tree') return null;
    tree = await gh(token, 'GET', `${repoPath(repo)}/git/trees/${e.sha}`);
  }
  return null;
}

// ---- Writes (only ever called after a person approved the staged change) -------------------------

export async function githubCreateBranch(token: string, repo: string, name: string, sha: string) {
  const j = await gh(token, 'POST', `${repoPath(repo)}/git/refs`, { ref: `refs/heads/${name}`, sha });
  return { ref: j.ref as string, sha: j.object?.sha as string };
}

/**
 * One commit with up to 10 text files on `branch`, whose parent must be `parentSha` (the head the person saw).
 * The ref update is never forced: if the branch moved since the approval, GitHub refuses and nothing changes.
 */
export async function githubCommitFiles(
  token: string,
  repo: string,
  input: { branch: string; parentSha: string; message: string; files: { path: string; content: string; mode: '100644' | '100755' }[] },
) {
  const base = repoPath(repo);
  const parent = await gh(token, 'GET', `${base}/git/commits/${encodeURIComponent(input.parentSha)}`);
  const tree: any[] = [];
  for (const f of input.files) {
    const b = await gh(token, 'POST', `${base}/git/blobs`, { content: f.content, encoding: 'utf-8' });
    tree.push({ path: f.path, mode: f.mode, type: 'blob', sha: b.sha });
  }
  const t = await gh(token, 'POST', `${base}/git/trees`, { base_tree: parent.tree?.sha, tree });
  const c = await gh(token, 'POST', `${base}/git/commits`, { message: input.message, tree: t.sha, parents: [input.parentSha] });
  await gh(token, 'PATCH', `${base}/git/refs/heads/${encPath(input.branch)}`, { sha: c.sha, force: false });
  return { sha: c.sha as string, url: `https://github.com/${repo}/commit/${c.sha}` };
}

export async function githubPrCreate(token: string, repo: string, input: { title: string; body: string; head: string; base: string; draft: boolean }) {
  const p = await gh(token, 'POST', `${repoPath(repo)}/pulls`, { title: input.title, body: input.body, head: input.head, base: input.base, draft: input.draft, maintainer_can_modify: false });
  return prRow(p);
}

export async function githubPrUpdate(token: string, repo: string, number: number, input: { title?: string; body?: string; state?: 'open' | 'closed'; base?: string }) {
  const p = await gh(token, 'PATCH', `${repoPath(repo)}/pulls/${number}`, input);
  return prRow(p);
}

export async function githubPrReview(
  token: string,
  repo: string,
  number: number,
  input: { event: 'COMMENT' | 'REQUEST_CHANGES'; body: string; commitId: string; comments?: { path: string; line: number; body: string }[] },
) {
  const r = await gh(token, 'POST', `${repoPath(repo)}/pulls/${number}/reviews`, {
    event: input.event,
    body: input.body,
    commit_id: input.commitId,
    ...(input.comments?.length ? { comments: input.comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })) } : {}),
  });
  return { id: r.id as number, state: r.state as string, url: r.html_url as string };
}

// ---- Diff for approval previews -------------------------------------------------------------------

/** A unified diff of two texts (3 lines of context), bounded so a preview stays readable. */
export function unifiedDiff(path: string, before: string | null, after: string, maxLines = 400): { text: string; added: number; removed: number; truncated: boolean } {
  const a = before == null ? [] : before.split('\n');
  const b = after.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  // Edit script for the middle: LCS when it is small enough, otherwise "replace all".
  type Op = { k: ' ' | '-' | '+'; s: string };
  let ops: Op[] = [];
  if (am.length * bm.length <= 2_000_000) {
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) (ops.push({ k: ' ', s: am[i]! }), i++, j++);
      else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ k: '-', s: am[i++]! });
      else ops.push({ k: '+', s: bm[j++]! });
    }
    while (i < n) ops.push({ k: '-', s: am[i++]! });
    while (j < m) ops.push({ k: '+', s: bm[j++]! });
  } else ops = [...am.map((s) => ({ k: '-' as const, s })), ...bm.map((s) => ({ k: '+' as const, s }))];
  const all: Op[] = [...a.slice(0, pre).map((s) => ({ k: ' ' as const, s })), ...ops, ...a.slice(a.length - suf).map((s) => ({ k: ' ' as const, s }))];
  const added = all.filter((o) => o.k === '+').length;
  const removed = all.filter((o) => o.k === '-').length;
  // Hunks with 3 lines of context.
  const out: string[] = [before == null ? `--- /dev/null` : `--- a/${path}`, `+++ b/${path}`];
  const changed = all.map((o, idx) => (o.k !== ' ' ? idx : -1)).filter((x) => x >= 0);
  let k = 0;
  let truncated = false;
  while (k < changed.length) {
    let start = Math.max(0, changed[k]! - 3);
    let end = Math.min(all.length - 1, changed[k]! + 3);
    while (k + 1 < changed.length && changed[k + 1]! - 3 <= end + 1) end = Math.min(all.length - 1, changed[++k]! + 3);
    k++;
    let oldLine = 1;
    let newLine = 1;
    for (let x = 0; x < start; x++) {
      if (all[x]!.k !== '+') oldLine++;
      if (all[x]!.k !== '-') newLine++;
    }
    const seg = all.slice(start, end + 1);
    const oldN = seg.filter((o) => o.k !== '+').length;
    const newN = seg.filter((o) => o.k !== '-').length;
    out.push(`@@ -${oldN ? oldLine : oldLine - 1},${oldN} +${newN ? newLine : newLine - 1},${newN} @@`);
    for (const o of seg) out.push(`${o.k}${o.s}`);
    if (out.length > maxLines) {
      truncated = true;
      break;
    }
    start = end;
  }
  const lines = out.slice(0, maxLines);
  if (truncated) lines.push(`… diff shortened (${added} added, ${removed} removed in total)`);
  return { text: lines.join('\n'), added, removed, truncated };
}
