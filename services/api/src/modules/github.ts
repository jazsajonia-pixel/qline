import { Hono } from 'hono';
import { z } from 'zod';
import { REPO } from '../integrations/connectors';
import { need, tx, type Env } from '../core/context';
import { ApiError } from '../core/errors';
import { connection } from '../agent/tools-apps';
import { githubFailure } from '../agent/tools-github';
import { githubRepos } from '../integrations/connectors';
import {
  capabilityReport,
  githubBranches,
  githubChecks,
  githubCommit,
  githubCommits,
  githubFile,
  githubInstallations,
  githubPull,
  githubPulls,
  githubRepo,
  githubRun,
  githubRuns,
  githubTree,
  UNUSED_RISKY,
} from '../integrations/github';

/**
 * v1.10 read-only GitHub routes for the app's GitHub screen (docs/24 §6). Every route needs tasks.read (the same
 * permission as the agent's GitHub reads), uses this organization's own connection (RLS-scoped), and changes
 * nothing. Changes happen only through agent tools with an approval.
 */
export const githubRoutes = new Hono<Env>();

async function token(c: any): Promise<string> {
  const t = need(c, 'tasks.read');
  const conn = await tx(t, (q) => connection(q, ['github']));
  if (typeof conn === 'string') throw new ApiError(409, 'GITHUB_NOT_CONNECTED', conn);
  return conn.token;
}

function repoParam(c: any) {
  const r = `${c.req.param('owner')}/${c.req.param('name')}`;
  if (!REPO.test(r)) throw new ApiError(400, 'BAD_REPO', 'Use owner/name for the repository.');
  return r;
}

const intQ = (v: string | undefined, d: number, max: number) => {
  const n = v == null ? d : Number(v);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : d;
};
const refQ = (v: string | undefined) => (v && v.length <= 250 ? v : null);

/** Runs a GitHub read and maps provider errors to a plain answer (403s name the missing app permission). */
async function gh<T>(need_: Parameters<typeof githubFailure>[1], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const m = githubFailure(e, need_);
    if (m) {
      const status = (e as any)?.status;
      throw new ApiError(status === 404 ? 404 : status === 400 ? 400 : 502, status === 403 ? 'GITHUB_PERMISSION' : 'GITHUB_ERROR', m);
    }
    throw e;
  }
}

githubRoutes.get('/github/capabilities', async (c) => {
  const tk = await token(c);
  const installs = await gh('code', () => githubInstallations(tk));
  return c.json({
    installed: installs.length > 0,
    installations: installs.map((i) => ({
      account: i.account,
      accountType: i.accountType,
      repositorySelection: i.repositorySelection,
      suspended: i.suspended,
      permissions: i.permissions,
      unusedRisky: Object.keys(i.permissions).filter((p) => UNUSED_RISKY.includes(p)),
    })),
    capabilities: capabilityReport(installs),
    guarantees: [
      'Every change asks you first and shows the diff.',
      'Never pushes to the default branch or a protected branch.',
      'Never merges, force-pushes or deletes branches.',
      'Never changes GitHub Actions workflows and never reads secrets.',
    ],
  });
});

githubRoutes.get('/github/repos', async (c) => {
  const tk = await token(c);
  const r = await gh('code', () => githubRepos(tk, intQ(c.req.query('limit'), 50, 100)));
  return c.json(r);
});

githubRoutes.get('/github/repos/:owner/:name', async (c) => {
  const tk = await token(c);
  return c.json(await gh('code', () => githubRepo(tk, repoParam(c))));
});

githubRoutes.get('/github/repos/:owner/:name/tree', async (c) => {
  const tk = await token(c);
  return c.json(await gh('code', () => githubTree(tk, repoParam(c), { ref: refQ(c.req.query('ref')), path: c.req.query('path') ?? null })));
});

githubRoutes.get('/github/repos/:owner/:name/file', async (c) => {
  const tk = await token(c);
  const path = z.string().min(1).max(400).safeParse(c.req.query('path'));
  if (!path.success) throw new ApiError(400, 'BAD_PATH', 'Give the file path.');
  return c.json(await gh('code', () => githubFile(tk, repoParam(c), path.data, { ref: refQ(c.req.query('ref')), page: intQ(c.req.query('page'), 1, 1000) })));
});

githubRoutes.get('/github/repos/:owner/:name/branches', async (c) => {
  const tk = await token(c);
  return c.json(await gh('code', () => githubBranches(tk, repoParam(c), { query: c.req.query('q') ?? null, limit: intQ(c.req.query('limit'), 50, 100) })));
});

githubRoutes.get('/github/repos/:owner/:name/commits', async (c) => {
  const tk = await token(c);
  return c.json({ commits: await gh('code', () => githubCommits(tk, repoParam(c), { ref: refQ(c.req.query('ref')), limit: intQ(c.req.query('limit'), 20, 50) })) });
});

githubRoutes.get('/github/repos/:owner/:name/commits/:sha', async (c) => {
  const tk = await token(c);
  const sha = c.req.param('sha');
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new ApiError(400, 'BAD_SHA', 'Use a commit SHA.');
  return c.json(await gh('code', () => githubCommit(tk, repoParam(c), sha)));
});

githubRoutes.get('/github/repos/:owner/:name/pulls', async (c) => {
  const tk = await token(c);
  const state = (['open', 'closed', 'all'] as const).find((s) => s === c.req.query('state')) ?? 'open';
  return c.json({ pulls: await gh('pulls', () => githubPulls(tk, repoParam(c), { state, limit: intQ(c.req.query('limit'), 20, 50) })) });
});

githubRoutes.get('/github/repos/:owner/:name/pulls/:number', async (c) => {
  const tk = await token(c);
  return c.json(await gh('pulls', () => githubPull(tk, repoParam(c), intQ(c.req.param('number'), 0, 10_000_000))));
});

githubRoutes.get('/github/repos/:owner/:name/runs', async (c) => {
  const tk = await token(c);
  return c.json(await gh('ci', () => githubRuns(tk, repoParam(c), { branch: refQ(c.req.query('branch')), limit: intQ(c.req.query('limit'), 15, 50) })));
});

githubRoutes.get('/github/repos/:owner/:name/runs/:id', async (c) => {
  const tk = await token(c);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, 'BAD_RUN', 'Use a run id.');
  return c.json(await gh('ci', () => githubRun(tk, repoParam(c), id)));
});

githubRoutes.get('/github/repos/:owner/:name/checks', async (c) => {
  const tk = await token(c);
  const ref = refQ(c.req.query('ref'));
  if (!ref) throw new ApiError(400, 'BAD_REF', 'Give a branch, tag or commit.');
  return c.json(await gh('checks', () => githubChecks(tk, repoParam(c), ref)));
});
