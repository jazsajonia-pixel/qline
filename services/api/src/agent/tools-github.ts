import { z } from 'zod';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { ProviderHttpError, REPO } from '../integrations/connectors';
import {
  badPath,
  blockedWritePath,
  BRANCH,
  githubBranch,
  githubBranches,
  githubChecks,
  githubCodeSearch,
  githubCommit,
  githubCommitFiles,
  githubCommits,
  githubCompare,
  githubCreateBranch,
  githubFile,
  githubFileRaw,
  githubPrCreate,
  githubPrReview,
  githubPrUpdate,
  githubPull,
  githubPulls,
  githubRepo,
  githubRun,
  githubRuns,
  githubTree,
  githubTreeEntryMode,
  looksSecret,
  unifiedDiff,
} from '../integrations/github';
import { connection, fail } from './tools-apps';
import type { ToolCtx, ToolDef, ToolPreview, ToolResult } from './tools';

/**
 * v1.10 GitHub tools (docs/24). Reads are L0. Every write is L3, always asks a person (ALWAYS_ASK in
 * @qline/policy, so full autopilot cannot skip it), and is staged first: the branch head / PR head the person
 * saw is pinned in the stored args and checked again when it runs. Writes never touch the default branch or a
 * protected branch, never change workflows, never merge, force-push or delete. There is no secrets tool.
 */

type Staged<T> = { ok: true; args: T; preview: ToolPreview } | { ok: false; error: string };
const by = (ctx: ToolCtx) => ({ orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id });
const repo = z.string().regex(REPO, 'Use owner/name');
const ref = z.string().trim().min(1).max(250);
const branchName = z.string().trim().regex(BRANCH, 'Use a branch name like qline/fix-typo');
const NOT_STAGED = 'This change was not reviewed in Approvals, so Qline will not make it. Ask for it again.';

/** The GitHub App permission each tool family needs, for the "not accessible by integration" answer. */
const NEEDS: Record<string, string> = {
  code: 'Contents (read)',
  write: 'Contents (read and write)',
  pulls: 'Pull requests (read)',
  pullsWrite: 'Pull requests (read and write)',
  ci: 'Actions (read)',
  checks: 'Checks (read) and Commit statuses (read)',
};

/** Provider failures in plain language. 403s name the GitHub App permission that is missing. */
export function githubFailure(e: unknown, need: keyof typeof NEEDS): string | null {
  if (e instanceof ProviderHttpError) {
    if (e.status === 400) return e.message;
    if (e.status === 401) return 'GitHub rejected the connection. Reconnect GitHub in Settings → Integrations.';
    if (e.status === 403 && /not accessible by integration|resource not accessible/i.test(e.message))
      return `The Qline GitHub App does not have the ${NEEDS[need]} permission on this repository. The owner can grant it in the app's settings on GitHub; installations then ask to accept the new permission.`;
    if (e.status === 403 && /rate limit/i.test(e.message)) return 'GitHub is rate limiting requests. Try again in a minute.';
    if (e.status === 403) return `GitHub refused this: ${e.message}`;
    if (e.status === 404) return 'GitHub could not find that, or the Qline GitHub App is not installed on that repository.';
    if (e.status === 409) return `GitHub refused this because of a conflict: ${e.message}`;
    if (e.status === 422) return `GitHub refused this: ${e.message}`;
    if (e.status === 429) return 'GitHub is rate limiting requests. Try again in a minute.';
    return `GitHub: ${e.message}`;
  }
  if ((e as Error)?.name === 'TimeoutError') return 'GitHub did not answer in time.';
  return null;
}

async function withGithub(q: Q, need: keyof typeof NEEDS, fn: (token: string) => Promise<ToolResult>): Promise<ToolResult> {
  const c = await connection(q, ['github']);
  if (typeof c === 'string') return fail(c);
  try {
    return await fn(c.token);
  } catch (e) {
    const m = githubFailure(e, need);
    if (m) return fail(m);
    throw e;
  }
}

async function stageWith<T>(q: Q, need: keyof typeof NEEDS, fn: (token: string) => Promise<Staged<T>>): Promise<Staged<T>> {
  const c = await connection(q, ['github']);
  if (typeof c === 'string') return { ok: false, error: c };
  try {
    return await fn(c.token);
  } catch (e) {
    const m = githubFailure(e, need);
    if (m) return { ok: false, error: m };
    throw e;
  }
}

/** Qline's write floor for a branch, checked when staged and again when it runs. */
async function writableBranch(token: string, r: string, branch: string): Promise<{ ok: true; sha: string; defaultBranch: string } | { ok: false; error: string; missing?: boolean; defaultBranch?: string }> {
  const info = await githubRepo(token, r);
  if (info.archived) return { ok: false, error: `${r} is archived, so it cannot be changed.` };
  if (branch === info.defaultBranch) return { ok: false, error: `Qline never writes to the default branch (${info.defaultBranch}). Use a new branch and open a pull request.`, defaultBranch: info.defaultBranch };
  let b;
  try {
    b = await githubBranch(token, r, branch);
  } catch (e) {
    if (e instanceof ProviderHttpError && e.status === 404) return { ok: false, error: `There is no branch ${branch} in ${r}.`, missing: true, defaultBranch: info.defaultBranch };
    throw e;
  }
  if (b.protected) return { ok: false, error: `${branch} is a protected branch. Qline only writes to unprotected working branches.`, defaultBranch: info.defaultBranch };
  return { ok: true, sha: b.sha, defaultBranch: info.defaultBranch };
}

const MAX_FILE = 200_000;
/** Every line of a commit's diff is shown before approval; larger commits are refused, not shortened. */
const REVIEWABLE_LINES = 2000;
const MAX_TOTAL = 1_000_000;
const fileInput = z.object({ path: z.string().trim().min(1).max(400), content: z.string().max(MAX_FILE) });

export function checkFiles(files: { path: string; content: string }[]): string | null {
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    const bad = badPath(f.path) ?? blockedWritePath(f.path);
    if (bad) return `${f.path}: ${bad}`;
    if (seen.has(f.path)) return `${f.path} is listed twice.`;
    seen.add(f.path);
    if (f.content.includes('\0')) return `${f.path}: Qline only writes text files.`;
    if (looksSecret(f.content)) return `${f.path} contains what looks like a secret (an API key, token or private key). Qline does not commit secrets.`;
    if (f.content.includes('[redacted]')) return `${f.path} contains "[redacted]", which Qline puts in place of secrets when it reads files. Writing it back would break the file, so it was not staged.`;
    total += f.content.length;
  }
  if (total > MAX_TOTAL) return 'That is more than 1 MB of changes for one commit. Split it up.';
  return null;
}

type CommitPinned = { headSha: string | null; baseSha?: string; from?: string; defaultBranch: string; createBranch: boolean; files: { path: string; mode: '100644' | '100755'; existed: boolean }[] };
type BranchPinned = { baseSha: string; from: string; defaultBranch: string };
type PrPinned = { base: string; headSha: string; defaultBranch: string };
type PrUpdatePinned = { before: { title: string; state: string; base: string; body: string } };
type ReviewPinned = { commitId: string };

const pinned = <T>(a: unknown) => (a as { _pinned?: T })._pinned;

export const githubTools = {
  // ---------------------------------------------------------------- reads (L0)
  'github.repo': {
    description: 'Overview of one GitHub repository ("owner/name"): default branch, language, visibility, and what you may do there.',
    schema: z.object({ repo }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubRepo(t, a.repo);
        return { ok: true, summary: `${r.fullName} (default branch ${r.defaultBranch})`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Look at a GitHub repository', lines: [a.repo] }),
  } satisfies ToolDef<any>,

  'github.tree': {
    description: 'List the files and folders at a path in a repository (top level when path is empty), on a branch, tag or commit (default branch when ref is empty).',
    schema: z.object({ repo, path: z.string().max(400).optional(), ref: ref.optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubTree(t, a.repo, { ref: a.ref ?? null, path: a.path ?? null });
        return { ok: true, summary: `${r.entries.length} item${r.entries.length === 1 ? '' : 's'} in ${a.repo}/${r.path}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'List files on GitHub', lines: [`${a.repo}/${a.path ?? ''}`, a.ref ?? 'default branch'] }),
  } satisfies ToolDef<any>,

  'github.file': {
    description: 'Read a text file from a repository at a branch, tag or commit. Long files come in pages of 400 lines (use page). Secret-looking values are hidden as [redacted]; never write those back.',
    schema: z.object({ repo, path: z.string().trim().min(1).max(400), ref: ref.optional(), page: z.number().int().min(1).max(1000).optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubFile(t, a.repo, a.path, { ref: a.ref ?? null, page: a.page });
        return { ok: true, summary: `Read ${a.path}${r.pages > 1 ? ` (page ${r.page} of ${r.pages})` : ''}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read a file on GitHub', lines: [`${a.repo}/${a.path}`, a.ref ?? 'default branch'] }),
  } satisfies ToolDef<any>,

  'github.code_search': {
    description: "Search code in one repository. GitHub searches the default branch. Use words or GitHub code-search qualifiers like path:src language:ts.",
    schema: z.object({ repo, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(30).optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubCodeSearch(t, a.repo, a.query, a.limit ?? 15);
        return { ok: true, summary: `${r.total} match${r.total === 1 ? '' : 'es'} for “${a.query}” in ${a.repo}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Search code on GitHub', lines: [a.repo, a.query] }),
  } satisfies ToolDef<any>,

  'github.branches': {
    description: 'List branches in a repository with their head commit and whether they are protected or the default.',
    schema: z.object({ repo, query: z.string().max(100).optional(), limit: z.number().int().min(1).max(100).optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubBranches(t, a.repo, { query: a.query ?? null, limit: a.limit });
        return { ok: true, summary: `${r.branches.length} branch${r.branches.length === 1 ? '' : 'es'} in ${a.repo}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'List GitHub branches', lines: [a.repo] }),
  } satisfies ToolDef<any>,

  'github.commits': {
    description: 'Recent commits on a branch (default branch when ref is empty), optionally only those touching a path.',
    schema: z.object({ repo, ref: ref.optional(), path: z.string().max(400).optional(), limit: z.number().int().min(1).max(50).optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const rows = await githubCommits(t, a.repo, { ref: a.ref ?? null, path: a.path ?? null, limit: a.limit });
        return { ok: true, summary: `${rows.length} commit${rows.length === 1 ? '' : 's'} in ${a.repo}`, refs: [], data: rows };
      });
    },
    preview: (a) => ({ title: 'List GitHub commits', lines: [a.repo, a.ref ?? 'default branch'] }),
  } satisfies ToolDef<any>,

  'github.commit': {
    description: 'One commit with its message and changed files (patches shortened).',
    schema: z.object({ repo, sha: z.string().trim().regex(/^[0-9a-f]{7,40}$/i, 'Use a commit SHA') }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubCommit(t, a.repo, a.sha);
        return { ok: true, summary: `Commit ${r.short}: ${r.message.split('\n')[0]}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read a GitHub commit', lines: [`${a.repo}@${a.sha.slice(0, 7)}`] }),
  } satisfies ToolDef<any>,

  'github.compare': {
    description: 'Compare two branches, tags or commits (base...head): commits ahead/behind and changed files with patches.',
    schema: z.object({ repo, base: ref, head: ref }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'code', async (t) => {
        const r = await githubCompare(t, a.repo, a.base, a.head);
        return { ok: true, summary: `${a.head} is ${r.aheadBy} ahead and ${r.behindBy} behind ${a.base}; ${r.files.length} file${r.files.length === 1 ? '' : 's'} changed`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Compare on GitHub', lines: [a.repo, `${a.base}...${a.head}`] }),
  } satisfies ToolDef<any>,

  'github.pulls': {
    description: 'List pull requests in a repository (open by default), newest activity first.',
    schema: z.object({ repo, state: z.enum(['open', 'closed', 'all']).default('open'), limit: z.number().int().min(1).max(50).optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'pulls', async (t) => {
        const rows = await githubPulls(t, a.repo, { state: a.state, limit: a.limit });
        return { ok: true, summary: `${rows.length} pull request${rows.length === 1 ? '' : 's'} in ${a.repo}`, refs: [], data: rows };
      });
    },
    preview: (a) => ({ title: 'List pull requests', lines: [a.repo, a.state] }),
  } satisfies ToolDef<any>,

  'github.pull': {
    description: 'One pull request: description, changed files with patches, reviews and the state of its checks.',
    schema: z.object({ repo, number: z.number().int().min(1) }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'pulls', async (t) => {
        const r = await githubPull(t, a.repo, a.number);
        return { ok: true, summary: `PR #${r.number} “${r.title}” (${r.state}${r.draft ? ', draft' : ''}; checks ${r.checks?.overall ?? 'unknown'})`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read a pull request', lines: [`${a.repo}#${a.number}`] }),
  } satisfies ToolDef<any>,

  'github.runs': {
    description: 'Recent GitHub Actions workflow runs in a repository, optionally for one branch or status (e.g. failure, in_progress).',
    schema: z.object({ repo, branch: ref.optional(), status: z.enum(['completed', 'in_progress', 'queued', 'failure', 'success', 'cancelled']).optional(), limit: z.number().int().min(1).max(50).optional() }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'ci', async (t) => {
        const r = await githubRuns(t, a.repo, { branch: a.branch ?? null, status: a.status ?? null, limit: a.limit });
        return { ok: true, summary: `${r.runs.length} workflow run${r.runs.length === 1 ? '' : 's'} in ${a.repo}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'List CI runs', lines: [a.repo, a.branch ?? 'all branches'] }),
  } satisfies ToolDef<any>,

  'github.run': {
    description: 'One workflow run: its jobs and steps, and for failed jobs the end of the log (secrets masked). Use it to explain why CI failed.',
    schema: z.object({ repo, runId: z.number().int().min(1) }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'ci', async (t) => {
        const r = await githubRun(t, a.repo, a.runId);
        const failed = r.jobs.filter((j: any) => ['failure', 'timed_out', 'cancelled'].includes(j.conclusion)).length;
        return { ok: true, summary: `Run “${r.name}” ${r.conclusion ?? r.status}: ${r.jobs.length} job${r.jobs.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read a CI run', lines: [`${a.repo} run ${a.runId}`] }),
  } satisfies ToolDef<any>,

  'github.checks': {
    description: 'Check runs and commit statuses for a branch, tag or commit, with an overall passing / failing / pending answer.',
    schema: z.object({ repo, ref }),
    async execute(q, _ctx, a) {
      return withGithub(q, 'checks', async (t) => {
        const r = await githubChecks(t, a.repo, a.ref);
        return { ok: true, summary: `Checks on ${a.ref}: ${r.overall} (${r.checkRuns.length + r.statuses.length})`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read checks', lines: [a.repo, a.ref] }),
  } satisfies ToolDef<any>,

  // ---------------------------------------------------------------- writes (L3, always approved, staged)
  'github.branch.create': {
    description: 'Create a new branch from another branch or commit (the default branch when from is empty). Always needs approval.',
    schema: z.object({ repo, name: branchName, from: ref.optional() }),
    async stage(q, _ctx, a): Promise<Staged<any>> {
      return stageWith(q, 'write', async (t) => {
        const info = await githubRepo(t, a.repo);
        if (a.name === info.defaultBranch) return { ok: false, error: `${a.name} is the default branch and already exists.` };
        const exists = await githubBranch(t, a.repo, a.name).then(() => true, (e) => (e instanceof ProviderHttpError && e.status === 404 ? false : Promise.reject(e)));
        if (exists) return { ok: false, error: `A branch called ${a.name} already exists in ${a.repo}.` };
        const from = a.from ?? info.defaultBranch;
        const baseSha = /^[0-9a-f]{40}$/i.test(from) ? from : (await githubBranch(t, a.repo, from)).sha;
        const p: BranchPinned = { baseSha, from, defaultBranch: info.defaultBranch };
        return { ok: true, args: { ...a, _pinned: p }, preview: { title: `Create branch ${a.name}`, lines: [a.repo, `From ${from} at ${baseSha.slice(0, 7)}`] } };
      });
    },
    async execute(q, ctx, a) {
      const p = pinned<BranchPinned>(a);
      if (!p) return fail(NOT_STAGED);
      return withGithub(q, 'write', async (t) => {
        const r = await githubCreateBranch(t, a.repo, a.name, p.baseSha);
        await audit(q, { ...by(ctx), action: 'github.branch_created', targetRef: `github:${a.repo}@${a.name}`, detail: { from: p.from, sha: p.baseSha } });
        return { ok: true, summary: `Created branch ${a.name} in ${a.repo} from ${p.from}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: `Create branch ${a.name}`, lines: [a.repo, `From ${pinned<BranchPinned>(a)?.from ?? a.from ?? 'the default branch'}`] }),
  } satisfies ToolDef<any>,

  'github.files.commit': {
    description:
      'Commit up to 10 text files (full new contents) to a working branch as one commit. If the branch does not exist yet, set createFrom to make it from that branch (usually the default branch). Never the default or a protected branch, never .github/workflows. Always needs approval; the person sees the diff.',
    schema: z.object({
      repo,
      branch: branchName,
      message: z.string().trim().min(1).max(2000),
      files: z.array(fileInput).min(1).max(10),
      createFrom: ref.optional().describe('Create the branch from this branch first, if it does not exist'),
    }),
    async stage(q, _ctx, a): Promise<Staged<any>> {
      return stageWith(q, 'write', async (t) => {
        const bad = checkFiles(a.files);
        if (bad) return { ok: false, error: bad };
        const w = await writableBranch(t, a.repo, a.branch);
        let headSha: string | null = null;
        let baseSha: string | undefined;
        let from: string | undefined;
        const defaultBranch = w.defaultBranch!;
        if (w.ok) headSha = w.sha;
        else if (w.missing && a.createFrom) {
          const src: string = a.createFrom;
          from = src;
          baseSha = /^[0-9a-f]{40}$/i.test(src) ? src : (await githubBranch(t, a.repo, src)).sha;
        } else return { ok: false, error: w.missing ? `${w.error} Set createFrom (for example ${w.defaultBranch}) to create it.` : w.error };
        const at = headSha ?? baseSha!;
        const files: CommitPinned['files'] = [];
        const diffs: string[] = [];
        let added = 0;
        let removed = 0;
        for (const f of a.files) {
          const before = await githubFileRaw(t, a.repo, f.path, at);
          if (before.exists && (before.binary || before.tooBig)) return { ok: false, error: `${f.path} is ${before.binary ? 'a binary file' : 'over 1 MB'} on GitHub; Qline only edits text files.` };
          const old = before.exists ? before.text : null;
          if (old === f.content) return { ok: false, error: `${f.path} would not change. Leave it out.` };
          const mode = before.exists ? await fileMode(t, a.repo, at, f.path) : '100644';
          files.push({ path: f.path, mode, existed: before.exists });
          const d = unifiedDiff(f.path, old, f.content, REVIEWABLE_LINES);
          if (d.truncated) return { ok: false, error: `The change to ${f.path} is too large to review in one approval (over ${REVIEWABLE_LINES} diff lines). Split it into smaller commits.` };
          added += d.added;
          removed += d.removed;
          diffs.push(d.text);
        }
        const p: CommitPinned = { headSha, baseSha, from, defaultBranch, createBranch: headSha == null, files };
        const diff = diffs.join('\n');
        if (diff.split('\n').length > REVIEWABLE_LINES) return { ok: false, error: `This commit is too large to review in one approval (over ${REVIEWABLE_LINES} diff lines). Split it into smaller commits.` };
        return {
          ok: true,
          args: { ...a, _pinned: p },
          preview: {
            title: `Commit ${files.length} file${files.length === 1 ? '' : 's'} to ${a.branch}`,
            lines: [
              a.repo,
              headSha ? `On ${a.branch} at ${headSha.slice(0, 7)}` : `New branch ${a.branch} from ${from} at ${baseSha!.slice(0, 7)}`,
              `Message: ${a.message.split('\n')[0]!.slice(0, 160)}`,
              ...files.map((f) => `${f.existed ? 'Change' : 'Add'} ${f.path}`),
              `+${added} −${removed} lines`,
            ],
            diff,
          },
        };
      });
    },
    async execute(q, ctx, a) {
      const p = pinned<CommitPinned>(a);
      if (!p) return fail(NOT_STAGED);
      const bad = checkFiles(a.files);
      if (bad) return fail(bad);
      if (a.files.length !== p.files.length || a.files.some((f: any, i: number) => f.path !== p.files[i]!.path)) return fail(NOT_STAGED);
      return withGithub(q, 'write', async (t) => {
        let parent: string;
        if (p.createBranch) {
          const exists = await githubBranch(t, a.repo, a.branch).then(() => true, (e) => (e instanceof ProviderHttpError && e.status === 404 ? false : Promise.reject(e)));
          if (exists) return fail(`A branch called ${a.branch} was created after this was approved, so nothing was committed. Ask again to see the current state.`);
          const info = await githubRepo(t, a.repo);
          if (a.branch === info.defaultBranch) return fail('Qline never writes to the default branch.');
          await githubCreateBranch(t, a.repo, a.branch, p.baseSha!);
          parent = p.baseSha!;
        } else {
          const w = await writableBranch(t, a.repo, a.branch);
          if (!w.ok) return fail(w.error);
          if (w.sha !== p.headSha) return fail(`${a.branch} changed since this was approved (it was at ${p.headSha!.slice(0, 7)}, now ${w.sha.slice(0, 7)}), so nothing was committed. Ask again to see the new diff.`);
          parent = p.headSha!;
        }
        let r;
        try {
          r = await githubCommitFiles(t, a.repo, {
            branch: a.branch,
            parentSha: parent,
            message: a.message,
            files: a.files.map((f: any, i: number) => ({ path: f.path, content: f.content, mode: p.files[i]!.mode })),
          });
        } catch (e) {
          if (e instanceof ProviderHttpError && e.status === 422) return fail(`${a.branch} moved while committing, so GitHub refused the update and the branch was left as it was (no force push). Ask again.`);
          throw e;
        }
        await audit(q, { ...by(ctx), action: 'github.files_committed', targetRef: `github:${a.repo}@${a.branch}`, detail: { sha: r.sha, parent, files: p.files.map((f) => f.path), createdBranch: p.createBranch } });
        return { ok: true, summary: `Committed ${a.files.length} file${a.files.length === 1 ? '' : 's'} to ${a.branch} (${r.sha.slice(0, 7)})`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: `Commit ${a.files?.length ?? 0} file(s) to ${a.branch}`, lines: [a.repo, a.message?.split('\n')[0] ?? '', ...(a.files ?? []).map((f: any) => f.path)] }),
  } satisfies ToolDef<any>,

  'github.pr.create': {
    description: 'Open a pull request from a working branch into base (the default branch when empty). Use draft for work in progress. Always needs approval. Qline never merges.',
    schema: z.object({ repo, head: branchName, base: ref.optional(), title: z.string().trim().min(1).max(256), body: z.string().max(20_000).default(''), draft: z.boolean().default(false) }),
    async stage(q, _ctx, a): Promise<Staged<any>> {
      return stageWith(q, 'pullsWrite', async (t) => {
        const info = await githubRepo(t, a.repo);
        const base = a.base ?? info.defaultBranch;
        if (a.head === base) return { ok: false, error: 'The head and base branch are the same.' };
        if (a.head === info.defaultBranch) return { ok: false, error: `Open pull requests from a working branch, not from ${info.defaultBranch}.` };
        const head = await githubBranch(t, a.repo, a.head);
        const cmp = await githubCompare(t, a.repo, base, head.sha);
        if (cmp.aheadBy === 0) return { ok: false, error: `${a.head} has no commits that ${base} does not have.` };
        const diff = cmp.files
          .map((f: any) => [`--- a/${f.from ?? f.path}`, `+++ b/${f.path}`, f.patch ?? `(${f.status}; no text diff)`].join('\n'))
          .join('\n')
          .split('\n')
          .slice(0, 1200)
          .join('\n');
        const p: PrPinned = { base, headSha: head.sha, defaultBranch: info.defaultBranch };
        return {
          ok: true,
          args: { ...a, base, _pinned: p },
          preview: {
            title: `${a.draft ? 'Open a draft' : 'Open a'} pull request: ${a.title}`,
            lines: [a.repo, `${a.head} (${head.sha.slice(0, 7)}) → ${base}`, `${cmp.aheadBy} commit${cmp.aheadBy === 1 ? '' : 's'}, ${cmp.files.length} file${cmp.files.length === 1 ? '' : 's'}`, a.body.slice(0, 300)],
            diff,
          },
        };
      });
    },
    async execute(q, ctx, a) {
      const p = pinned<PrPinned>(a);
      if (!p) return fail(NOT_STAGED);
      return withGithub(q, 'pullsWrite', async (t) => {
        const head = await githubBranch(t, a.repo, a.head);
        if (head.sha !== p.headSha) return fail(`${a.head} changed since this was approved, so the pull request was not opened. Ask again to see the new changes.`);
        const r = await githubPrCreate(t, a.repo, { title: a.title, body: a.body, head: a.head, base: p.base, draft: a.draft });
        await audit(q, { ...by(ctx), action: 'github.pr_created', targetRef: `github:${a.repo}#${r.number}`, detail: { head: a.head, base: p.base, draft: a.draft } });
        return { ok: true, summary: `Opened ${a.draft ? 'draft ' : ''}pull request #${r.number} in ${a.repo}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: `Open a pull request: ${a.title}`, lines: [a.repo, `${a.head} → ${a.base ?? 'default branch'}`] }),
  } satisfies ToolDef<any>,

  'github.pr.update': {
    description: 'Change a pull request title, description or base branch, or close / reopen it. Always needs approval. Never merges.',
    schema: z
      .object({ repo, number: z.number().int().min(1), title: z.string().trim().min(1).max(256).optional(), body: z.string().max(20_000).optional(), state: z.enum(['open', 'closed']).optional(), base: ref.optional() })
      .refine((a) => a.title != null || a.body != null || a.state != null || a.base != null, 'Change at least one of title, body, state or base'),
    async stage(q, _ctx, a): Promise<Staged<any>> {
      return stageWith(q, 'pullsWrite', async (t) => {
        const pr = await githubPull(t, a.repo, a.number);
        if (pr.state === 'merged') return { ok: false, error: `#${a.number} is already merged.` };
        const before = { title: pr.title, state: pr.state, base: pr.base, body: pr.body ?? '' };
        const lines = [a.repo + '#' + a.number];
        if (a.title != null && a.title !== before.title) lines.push(`Title: “${before.title}” → “${a.title}”`);
        if (a.state != null && a.state !== before.state) lines.push(a.state === 'closed' ? 'Close the pull request (not merged)' : 'Reopen the pull request');
        if (a.base != null && a.base !== before.base) lines.push(`Base: ${before.base} → ${a.base}`);
        if (a.body != null && a.body !== before.body) lines.push('Description changes (see diff)');
        if (lines.length === 1) return { ok: false, error: 'Nothing would change.' };
        const p: PrUpdatePinned = { before };
        return { ok: true, args: { ...a, _pinned: p }, preview: { title: `Update pull request #${a.number}`, lines, ...(a.body != null && a.body !== before.body ? { diff: unifiedDiff('description', before.body, a.body, 200).text } : {}) } };
      });
    },
    async execute(q, ctx, a) {
      const p = pinned<PrUpdatePinned>(a);
      if (!p) return fail(NOT_STAGED);
      return withGithub(q, 'pullsWrite', async (t) => {
        const r = await githubPrUpdate(t, a.repo, a.number, { ...(a.title != null ? { title: a.title } : {}), ...(a.body != null ? { body: a.body } : {}), ...(a.state != null ? { state: a.state } : {}), ...(a.base != null ? { base: a.base } : {}) });
        await audit(q, { ...by(ctx), action: 'github.pr_updated', targetRef: `github:${a.repo}#${a.number}`, detail: { fields: Object.keys(a).filter((k) => ['title', 'body', 'state', 'base'].includes(k)) } });
        return { ok: true, summary: `Updated pull request #${a.number} in ${a.repo}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: `Update pull request #${a.number}`, lines: [a.repo] }),
  } satisfies ToolDef<any>,

  'github.pr.review': {
    description:
      'Leave a review on a pull request: COMMENT or REQUEST_CHANGES, with optional comments on lines of the new code. Always needs approval. Qline does not approve pull requests (an approval can satisfy branch protection and lead to a merge).',
    schema: z.object({
      repo,
      number: z.number().int().min(1),
      event: z.enum(['COMMENT', 'REQUEST_CHANGES']),
      body: z.string().trim().min(1).max(20_000),
      comments: z.array(z.object({ path: z.string().trim().min(1).max(400), line: z.number().int().min(1), body: z.string().trim().min(1).max(5000) })).max(20).optional(),
    }),
    async stage(q, _ctx, a): Promise<Staged<any>> {
      return stageWith(q, 'pullsWrite', async (t) => {
        const pr = await githubPull(t, a.repo, a.number);
        if (pr.state !== 'open') return { ok: false, error: `#${a.number} is ${pr.state}; reviews go on open pull requests.` };
        const files = new Set(pr.files.map((f: any) => f.path));
        for (const c of a.comments ?? []) if (!files.has(c.path)) return { ok: false, error: `${c.path} is not changed in #${a.number}, so it cannot have a line comment.` };
        const p: ReviewPinned = { commitId: pr.headSha };
        return {
          ok: true,
          args: { ...a, _pinned: p },
          preview: {
            title: `${a.event === 'REQUEST_CHANGES' ? 'Request changes on' : 'Review'} pull request #${a.number}`,
            lines: [`${a.repo}#${a.number} “${pr.title}” at ${pr.headSha.slice(0, 7)}`, a.body.slice(0, 400), ...(a.comments ?? []).map((c: { path: string; line: number; body: string }) => `${c.path}:${c.line} — ${c.body.slice(0, 120)}`)],
          },
        };
      });
    },
    async execute(q, ctx, a) {
      const p = pinned<ReviewPinned>(a);
      if (!p) return fail(NOT_STAGED);
      return withGithub(q, 'pullsWrite', async (t) => {
        const pr = await githubPull(t, a.repo, a.number);
        if (pr.headSha !== p.commitId) return fail(`#${a.number} got new commits since this was approved, so the review was not posted. Ask again to review the current code.`);
        const r = await githubPrReview(t, a.repo, a.number, { event: a.event, body: a.body, commitId: p.commitId, comments: a.comments });
        await audit(q, { ...by(ctx), action: 'github.pr_reviewed', targetRef: `github:${a.repo}#${a.number}`, detail: { event: a.event, commit: p.commitId, comments: a.comments?.length ?? 0 } });
        return { ok: true, summary: `Posted a ${a.event === 'REQUEST_CHANGES' ? 'request for changes' : 'review comment'} on #${a.number}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: `Review pull request #${a.number}`, lines: [a.repo, a.event] }),
  } satisfies ToolDef<any>,
};

/** The existing mode of a file (keeps executables executable). */
async function fileMode(token: string, r: string, sha: string, path: string): Promise<'100644' | '100755'> {
  return (await githubTreeEntryMode(token, r, sha, path)) === '100755' ? '100755' : '100644';
}
