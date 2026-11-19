import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { accessToken } from '../integrations/oauth';
import {
  driveContent,
  driveDownload,
  DRIVE_KINDS,
  driveCreate,
  driveMeta,
  driveSearch,
  driveUpdate,
  githubComment,
  githubIssueCreate,
  githubIssues,
  githubRead,
  githubRepos,
  notionAppend,
  notionCreate,
  notionRead,
  notionSearch,
  ProviderHttpError,
  REPO,
  stripeCustomerCreate,
  stripeInvoiceDraft,
  stripeList,
  stripeSummary,
} from '../integrations/connectors';
import { detectFormat, parseFile, putObject } from '../modules/imports';
import { detectImage, extractFrom, IMAGE_MAX_BYTES, type Extracted } from '../modules/files';
import { DRIVE_READ_MAX_BYTES } from '../integrations/connectors';
import { connection, fail } from './tools-apps';
import type { Artifact, ToolCtx, ToolDef, ToolResult } from './tools';

/**
 * v1.6 run 3 connector tools: Google Drive, Notion, GitHub and Stripe.
 * Reads are L0. Writes go through the policy table (docs/09): Drive/Notion writes need approval
 * unless relaxed; GitHub issue writes and Stripe customer/draft-invoice writes are L3 (always approved).
 * Qline never finalizes, sends, refunds or charges in Stripe, and never writes code in GitHub.
 */

const DRIVE_READ = 'drive.readonly';
const DRIVE_FILE = 'drive.file';
const PAGE = 8000;

/** Runs a provider call and turns HTTP failures into a plain-language tool failure. */
async function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderHttpError) {
      if (e.status === 401) return fail(`${name} rejected the connection. Reconnect ${name} in Settings → Integrations.`);
      if (e.status === 403) return fail(`${name} does not allow this with the current access: ${e.message}`);
      if (e.status === 404) return fail(`${name} could not find that item, or Qline was not given access to it.`);
      if (e.status === 429) return fail(`${name} is rate limiting requests. Try again in a minute.`);
      return fail(`${name}: ${e.message}`);
    }
    if ((e as Error).name === 'TimeoutError') return fail(`${name} did not answer in time.`);
    throw e;
  }
}

/** Notion tokens can be refreshed; retry once after a 401 with a fresh token. */
async function withNotion<T>(q: Q, fn: (token: string) => Promise<T>): Promise<T | string> {
  const c = await connection(q, ['notion']);
  if (typeof c === 'string') return c;
  try {
    return await fn(c.token);
  } catch (e) {
    if (e instanceof ProviderHttpError && e.status === 401 && c.conn.token_ciphertext) {
      const fresh = await accessToken(q, c.conn, true).catch(() => null);
      if (fresh) return fn(fresh);
    }
    throw e;
  }
}

const idem = (ctx: ToolCtx, tool: string, a: unknown) => createHash('sha256').update(`${ctx.orgId}:${tool}:${JSON.stringify(a)}`).digest('hex').slice(0, 40);
const by = (ctx: ToolCtx) => ({ orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id });

export const connectorTools = {
  // ---- Google Drive ----
  'drive.search': {
    description:
      'Search the connected Google Drive. Filter by kind (image, video, pdf, document, spreadsheet, presentation, folder). For "latest" or "last" files set newest to "modified" (last changed) or "created" (added to Drive) and say which one you used; results are then strictly newest first. Without newest, a text search is by relevance. Pass nextPageToken back as pageToken for more.',
    schema: z.object({
      query: z.string().max(200).optional(),
      kind: z.enum(Object.keys(DRIVE_KINDS) as [keyof typeof DRIVE_KINDS, ...(keyof typeof DRIVE_KINDS)[]]).optional(),
      newest: z.enum(['modified', 'created']).optional(),
      limit: z.number().int().min(1).max(25).optional(),
      pageToken: z.string().max(500).optional(),
    }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['google'], () => DRIVE_READ);
      if (typeof c === 'string') return fail(c);
      return guard('Google Drive', async () => {
        const r = await driveSearch(c.token, { text: a.query ?? null, kind: a.kind ?? null, newest: a.newest ?? null, limit: a.limit ?? 10, pageToken: a.pageToken ?? null });
        return {
          ok: true,
          summary: `${r.files.length} Drive file${r.files.length === 1 ? '' : 's'} found`,
          refs: [],
          data: { ordering: r.ordering, files: r.files, nextPageToken: r.nextPageToken },
        };
      });
    },
    preview: (a) => ({ title: 'Search Google Drive', lines: [[a.query || (a.kind ? `${a.kind} files` : 'recent files'), a.newest ? `newest by ${a.newest} time` : null].filter(Boolean).join(' · ')] }),
  } satisfies ToolDef<any>,

  'drive.fetch': {
    description:
      'Bring one Google Drive file into this chat by id from drive.search: images are shown inline, other files appear as a file card the user can open or save. Docs and Slides come as PDF, Sheets as XLSX. Limits: 5 MB for images, 10 MB for other files. It makes a private copy in Qline; the Drive file is not shared or changed.',
    schema: z.object({ fileId: z.string().trim().min(5).max(200), caption: z.string().max(200).optional() }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google'], () => DRIVE_READ);
      if (typeof c === 'string') return fail(c);
      return guard('Google Drive', async () => {
        const meta = await driveMeta(c.token, a.fileId);
        const imageLike = meta.mimeType.startsWith('image/');
        const { bytes, name, mime } = await driveDownload(c.token, meta, imageLike ? IMAGE_MAX_BYTES : DRIVE_READ_MAX_BYTES);
        const img = detectImage(bytes);
        const safeName = name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'drive-file';
        let extracted: Extracted;
        if (img) extracted = { kind: 'image' };
        else if (imageLike) return fail(`“${meta.name}” is an image type Qline cannot show (PNG, JPEG, WebP and GIF work). Open it in Drive: ${meta.webViewLink ?? ''}`.trim());
        else {
          try {
            extracted = extractFrom(await parseFile(detectFormat(safeName, bytes), bytes));
          } catch {
            extracted = { kind: 'document', text: '', chars: 0, truncated: false, note: 'Qline cannot read the contents of this file type; it can still be opened or saved.' };
          }
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        // The same Drive file brought in again in this workspace reuses its copy.
        let file = await q.one<{ id: string }>(`select id from files where workspace_id=$1 and source='drive' and sha256=$2 and name=$3 limit 1`, [ctx.workspaceId, sha, safeName]);
        if (!file) {
          const id = randomUUID();
          const key = `org/${ctx.orgId}/ws/${ctx.workspaceId}/drive/${id}`;
          await putObject(key, bytes, img ?? (mime || 'application/octet-stream'));
          file = await q.one<{ id: string }>(
            `insert into files (id, org_id, workspace_id, name, mime, size_bytes, sha256, storage_key, created_by, source, extracted)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'drive',$10) returning id`,
            [id, ctx.orgId, ctx.workspaceId, safeName, img ?? (mime || 'application/octet-stream'), bytes.length, sha, key, ctx.userId, JSON.stringify(extracted)],
          );
        }
        await audit(q, { ...by(ctx), action: 'drive.file_fetched', targetRef: `file:${file!.id}`, detail: { drive: meta.id, name: meta.name, size: bytes.length } });
        const when = { modified: meta.modifiedTime, created: meta.createdTime };
        const artifact: Artifact = img
          ? { type: 'image', fileId: file!.id, name: safeName, caption: a.caption }
          : { type: 'file', fileId: file!.id, name: safeName, kind: extracted.kind === 'records' ? 'records' : 'document', size: bytes.length, source: 'Google Drive' };
        return {
          ok: true,
          summary: `Brought “${meta.name}” from Google Drive`,
          refs: [{ type: 'file', id: file!.id, title: meta.name }],
          artifacts: [artifact],
          data: {
            fileId: file!.id,
            name: meta.name,
            kind: img ? 'image' : extracted.kind,
            size: bytes.length,
            ...when,
            driveLink: meta.webViewLink,
            preview: !img && extracted.kind === 'document' ? (extracted.text ?? '').slice(0, 1500) : undefined,
          },
        };
      });
    },
    preview: (a) => ({ title: 'Bring a file from Google Drive', lines: [a.fileId] }),
  } satisfies ToolDef<any>,

  'drive.read': {
    description: 'Read a Google Drive file (Docs, Sheets, Slides, PDF, DOCX, XLSX, CSV, TXT, MD) by id from drive.search. Long files come back in pages: pass page=2 and so on.',
    schema: z.object({ fileId: z.string().trim().min(5).max(200), page: z.number().int().min(1).max(50).optional() }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['google'], () => DRIVE_READ);
      if (typeof c === 'string') return fail(c);
      return guard('Google Drive', async () => {
        const meta = await driveMeta(c.token, a.fileId);
        const { bytes, name } = await driveContent(c.token, meta);
        let text: string;
        try {
          const parsed = await parseFile(detectFormat(name, bytes), bytes);
          text = parsed.kind === 'document' ? (parsed.text ?? '') : [parsed.columns.join(','), ...parsed.rows.map((r) => parsed.columns.map((k) => r[k] ?? '').join(','))].join('\n');
        } catch (e) {
          return fail(`Qline cannot read “${meta.name}”: ${(e as Error).message}`);
        }
        const page = a.page ?? 1;
        const pages = Math.max(1, Math.ceil(text.length / PAGE));
        return {
          ok: true,
          summary: `Read “${meta.name}”${pages > 1 ? ` (page ${page} of ${pages})` : ''}`,
          refs: [],
          data: { id: meta.id, name: meta.name, link: meta.webViewLink, modified: meta.modifiedTime, page, pages, text: text.slice((page - 1) * PAGE, page * PAGE) },
        };
      });
    },
    preview: (a) => ({ title: 'Read a Drive file', lines: [a.fileId] }),
  } satisfies ToolDef<any>,

  'drive.create': {
    description: 'Create a new file in Google Drive: a Google Doc (kind "doc", plain text or simple Markdown), a Google Sheet (kind "sheet", CSV text) or a text file.',
    schema: z.object({
      name: z.string().trim().min(1).max(200),
      kind: z.enum(['doc', 'sheet', 'text']).default('doc'),
      content: z.string().max(200_000),
      folderId: z.string().trim().max(200).optional(),
    }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google'], () => DRIVE_FILE);
      if (typeof c === 'string') return fail(c);
      return guard('Google Drive', async () => {
        const f = await driveCreate(c.token, { name: a.name, content: a.content, kind: a.kind, folderId: a.folderId ?? null });
        await audit(q, { ...by(ctx), action: 'drive.file_created', targetRef: `drive:${f.id}`, detail: { name: f.name, kind: a.kind } });
        return { ok: true, summary: `Created “${f.name}” in Google Drive`, refs: [], data: { id: f.id, link: f.webViewLink } };
      });
    },
    preview: (a) => ({ title: 'Create a Google Drive file', lines: [a.name, `Type: ${a.kind}`, `${a.content.length} characters`] }),
  } satisfies ToolDef<any>,

  'drive.update': {
    description: 'Replace the content of a Google Drive file that Qline created (Google only lets Qline change its own files). Read it first and send the full new content.',
    schema: z.object({ fileId: z.string().trim().min(5).max(200), content: z.string().max(200_000) }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google'], () => DRIVE_FILE);
      if (typeof c === 'string') return fail(c);
      return guard('Google Drive', async () => {
        const meta = await driveMeta(c.token, a.fileId);
        const f = await driveUpdate(c.token, a.fileId, a.content, meta.mimeType);
        await audit(q, { ...by(ctx), action: 'drive.file_updated', targetRef: `drive:${f.id}`, detail: { name: f.name } });
        return { ok: true, summary: `Updated “${f.name}” in Google Drive`, refs: [], data: { id: f.id, link: f.webViewLink } };
      });
    },
    preview: (a) => ({ title: 'Update a Google Drive file', lines: [a.fileId, `${a.content.length} characters`] }),
  } satisfies ToolDef<any>,

  'drive.save_to_library': {
    description: 'Copy the text of a Google Drive file into the Qline Library as a document so the team can search it.',
    schema: z.object({ fileId: z.string().trim().min(5).max(200), folder: z.string().trim().max(80).optional() }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google'], () => DRIVE_READ);
      if (typeof c === 'string') return fail(c);
      return guard('Google Drive', async () => {
        const meta = await driveMeta(c.token, a.fileId);
        const { bytes, name } = await driveContent(c.token, meta);
        const parsed = await parseFile(detectFormat(name, bytes), bytes).catch((e) => e as Error);
        if (parsed instanceof Error) return fail(`Qline cannot read “${meta.name}”: ${parsed.message}`);
        const text = parsed.kind === 'document' ? (parsed.text ?? '') : [parsed.columns.join(','), ...parsed.rows.map((r) => parsed.columns.map((k) => r[k] ?? '').join(','))].join('\n');
        const d = await q.one(
          `insert into documents (org_id, workspace_id, kind, title, body, folder, source_kind, source_ref, created_by) values ($1,$2,'document',$3,$4,$5,'connector',$6,$7) returning id, title`,
          [ctx.orgId, ctx.workspaceId, meta.name.replace(/\.[^.]+$/, ''), text.slice(0, 500_000), a.folder ?? 'From Google Drive', `drive:${meta.id}`, `${ctx.actor.kind}:${ctx.actor.id}`],
        );
        await audit(q, { ...by(ctx), action: 'document.created', targetRef: `document:${d.id}`, detail: { fromDrive: meta.id } });
        return { ok: true, summary: `Saved “${d.title}” from Drive to the Library`, refs: [{ type: 'document', id: d.id, title: d.title }] };
      });
    },
    preview: (a) => ({ title: 'Save a Drive file to the Library', lines: [a.fileId, `Folder: ${a.folder ?? 'From Google Drive'}`] }),
  } satisfies ToolDef<any>,

  // ---- Notion ----
  'notion.search': {
    description: 'Search Notion pages that the user shared with Qline. Returns page titles, links and ids.',
    schema: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(25).optional() }),
    async execute(q, _ctx, a) {
      return guard('Notion', async () => {
        const r = await withNotion(q, (t) => notionSearch(t, a.query ?? null, a.limit ?? 10));
        if (typeof r === 'string') return fail(r);
        return { ok: true, summary: `${r.length} Notion page${r.length === 1 ? '' : 's'} found${r.length ? '' : ' (only pages shared with Qline appear)'}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Search Notion', lines: [a.query || 'recent pages'] }),
  } satisfies ToolDef<any>,

  'notion.read': {
    description: 'Read a Notion page as text (use an id from notion.search).',
    schema: z.object({ pageId: z.string().trim().min(10).max(100) }),
    async execute(q, _ctx, a) {
      return guard('Notion', async () => {
        const r = await withNotion(q, (t) => notionRead(t, a.pageId));
        if (typeof r === 'string') return fail(r);
        return { ok: true, summary: `Read “${r.title}”${r.truncated ? ' (first part)' : ''}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read a Notion page', lines: [a.pageId] }),
  } satisfies ToolDef<any>,

  'notion.create': {
    description: 'Create a Notion page under a parent page the user shared with Qline. Content is plain text; lines starting with #, -, or [ ] become headings, bullets and to-dos.',
    schema: z.object({ parentPageId: z.string().trim().min(10).max(100), title: z.string().trim().min(1).max(200), content: z.string().max(50_000) }),
    async execute(q, ctx, a) {
      return guard('Notion', async () => {
        const r = await withNotion(q, (t) => notionCreate(t, a.parentPageId, a.title, a.content));
        if (typeof r === 'string') return fail(r);
        await audit(q, { ...by(ctx), action: 'notion.page_created', targetRef: `notion:${r.id}`, detail: { title: a.title } });
        return { ok: true, summary: `Created the Notion page “${a.title}”`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Create a Notion page', lines: [a.title, `Under page ${a.parentPageId}`] }),
  } satisfies ToolDef<any>,

  'notion.append': {
    description: 'Add text to the end of a Notion page.',
    schema: z.object({ pageId: z.string().trim().min(10).max(100), content: z.string().min(1).max(50_000) }),
    async execute(q, ctx, a) {
      return guard('Notion', async () => {
        const r = await withNotion(q, (t) => notionAppend(t, a.pageId, a.content));
        if (typeof r === 'string') return fail(r);
        await audit(q, { ...by(ctx), action: 'notion.page_appended', targetRef: `notion:${a.pageId}`, detail: { blocks: r.blocks } });
        return { ok: true, summary: `Added ${r.blocks} block${r.blocks === 1 ? '' : 's'} to the Notion page`, refs: [] };
      });
    },
    preview: (a) => ({ title: 'Add to a Notion page', lines: [a.pageId, a.content.slice(0, 160)] }),
  } satisfies ToolDef<any>,

  // ---- GitHub ----
  'github.repos': {
    description: 'List the GitHub repositories Qline can see (where the Qline GitHub App is installed).',
    schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['github']);
      if (typeof c === 'string') return fail(c);
      return guard('GitHub', async () => {
        const r = await githubRepos(c.token, a.limit ?? 30);
        if (!r.installed) return fail('The Qline GitHub App is not installed on any repository yet. Install it from the app page on GitHub, then try again.');
        return { ok: true, summary: `${r.repos.length} repositor${r.repos.length === 1 ? 'y' : 'ies'}`, refs: [], data: r.repos };
      });
    },
    preview: () => ({ title: 'List GitHub repositories', lines: [] }),
  } satisfies ToolDef<any>,

  'github.issues': {
    description: 'List or search issues and pull requests in one repository ("owner/name").',
    schema: z.object({
      repo: z.string().regex(REPO, 'Use owner/name'),
      state: z.enum(['open', 'closed', 'all']).default('open'),
      kind: z.enum(['issues', 'pulls', 'both']).default('both'),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(30).optional(),
    }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['github']);
      if (typeof c === 'string') return fail(c);
      return guard('GitHub', async () => {
        const rows = await githubIssues(c.token, a.repo, { state: a.state, kind: a.kind, query: a.query ?? null, limit: a.limit });
        return { ok: true, summary: `${rows.length} item${rows.length === 1 ? '' : 's'} in ${a.repo}`, refs: [], data: rows };
      });
    },
    preview: (a) => ({ title: 'List GitHub issues', lines: [a.repo, a.state] }),
  } satisfies ToolDef<any>,

  'github.read': {
    description: 'Read one GitHub issue or pull request with its latest comments.',
    schema: z.object({ repo: z.string().regex(REPO, 'Use owner/name'), number: z.number().int().min(1) }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['github']);
      if (typeof c === 'string') return fail(c);
      return guard('GitHub', async () => {
        const r = await githubRead(c.token, a.repo, a.number);
        return { ok: true, summary: `Read ${r.pr ? 'pull request' : 'issue'} #${r.number} “${r.title}”`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Read a GitHub issue', lines: [`${a.repo}#${a.number}`] }),
  } satisfies ToolDef<any>,

  'github.issue.create': {
    description: 'Open a new GitHub issue in a repository. Always needs approval.',
    schema: z.object({ repo: z.string().regex(REPO, 'Use owner/name'), title: z.string().trim().min(1).max(256), body: z.string().max(20_000).default(''), labels: z.array(z.string().max(50)).max(10).optional() }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['github']);
      if (typeof c === 'string') return fail(c);
      return guard('GitHub', async () => {
        const r = await githubIssueCreate(c.token, a.repo, a.title, a.body, a.labels);
        await audit(q, { ...by(ctx), action: 'github.issue_created', targetRef: `github:${a.repo}#${r.number}`, detail: { title: a.title } });
        return { ok: true, summary: `Opened issue #${r.number} in ${a.repo}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Open a GitHub issue', lines: [a.repo, a.title, a.body.slice(0, 200)] }),
  } satisfies ToolDef<any>,

  'github.issue.comment': {
    description: 'Add a comment to a GitHub issue or pull request. Always needs approval.',
    schema: z.object({ repo: z.string().regex(REPO, 'Use owner/name'), number: z.number().int().min(1), body: z.string().trim().min(1).max(20_000) }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['github']);
      if (typeof c === 'string') return fail(c);
      return guard('GitHub', async () => {
        const r = await githubComment(c.token, a.repo, a.number, a.body);
        await audit(q, { ...by(ctx), action: 'github.commented', targetRef: `github:${a.repo}#${a.number}`, detail: { comment: r.id } });
        return { ok: true, summary: `Commented on ${a.repo}#${a.number}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Comment on GitHub', lines: [`${a.repo}#${a.number}`, a.body.slice(0, 200)] }),
  } satisfies ToolDef<any>,

  // ---- Stripe ----
  'stripe.summary': {
    description: 'Summarize Stripe for the last N days: payments received, refunds, failed payments, open invoices and balance. Amounts are in major units per currency.',
    schema: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['stripe']);
      if (typeof c === 'string') return fail(c);
      return guard('Stripe', async () => {
        const s = await stripeSummary(c.token, a.days);
        return { ok: true, summary: `Stripe summary for the last ${a.days} days${s.more ? ' (based on the latest 100 payments)' : ''}`, refs: [], data: s };
      });
    },
    preview: (a) => ({ title: 'Stripe summary', lines: [`Last ${a.days} days`] }),
  } satisfies ToolDef<any>,

  'stripe.list': {
    description: 'List Stripe customers, charges, invoices, subscriptions or products (newest first). Customers can be filtered by email; invoices and subscriptions by status.',
    schema: z.object({
      object: z.enum(['customers', 'charges', 'invoices', 'subscriptions', 'products']),
      email: z.string().email().optional(),
      status: z.string().max(30).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['stripe']);
      if (typeof c === 'string') return fail(c);
      return guard('Stripe', async () => {
        const r = await stripeList(c.token, a.object, { email: a.email ?? null, status: a.status ?? null, limit: a.limit });
        return { ok: true, summary: `${r.rows.length} ${a.object}${r.more ? ' (more exist)' : ''}`, refs: [], data: r.rows };
      });
    },
    preview: (a) => ({ title: 'List from Stripe', lines: [a.object] }),
  } satisfies ToolDef<any>,

  'stripe.customer.create': {
    description: 'Create a customer in Stripe. Always needs approval.',
    schema: z.object({ name: z.string().trim().min(1).max(200), email: z.string().email().optional(), description: z.string().max(500).optional() }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['stripe']);
      if (typeof c === 'string') return fail(c);
      return guard('Stripe', async () => {
        const r = await stripeCustomerCreate(c.token, { name: a.name, email: a.email ?? null, description: a.description ?? null }, idem(ctx, 'customer', a));
        await audit(q, { ...by(ctx), action: 'stripe.customer_created', targetRef: `stripe:${r.id}`, detail: { name: a.name } });
        return { ok: true, summary: `Created the Stripe customer ${a.name}`, refs: [], data: r };
      });
    },
    preview: (a) => ({ title: 'Create a Stripe customer', lines: [a.name, a.email ?? ''] }),
  } satisfies ToolDef<any>,

  'stripe.invoice.draft': {
    description:
      'Prepare a DRAFT Stripe invoice for an existing customer (id from stripe.list). Qline never finalizes, sends or charges it: a person reviews and sends it in Stripe. Amounts are in major units (e.g. 1500.50).',
    schema: z.object({
      customerId: z.string().regex(/^cus_[A-Za-z0-9]+$/),
      currency: z.string().regex(/^[A-Za-z]{3}$/),
      items: z.array(z.object({ description: z.string().trim().min(1).max(300), amount: z.number().positive().max(1_000_000) })).min(1).max(20),
      daysUntilDue: z.number().int().min(1).max(120).default(14),
      memo: z.string().max(500).optional(),
    }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['stripe']);
      if (typeof c === 'string') return fail(c);
      return guard('Stripe', async () => {
        const r = await stripeInvoiceDraft(c.token, { customer: a.customerId, currency: a.currency, items: a.items, daysUntilDue: a.daysUntilDue, memo: a.memo ?? null }, idem(ctx, 'invoice', a));
        const total = a.items.reduce((s: number, i: { amount: number }) => s + i.amount, 0);
        await audit(q, { ...by(ctx), action: 'stripe.invoice_drafted', targetRef: `stripe:${r.id}`, detail: { customer: a.customerId, total, currency: a.currency.toUpperCase() } });
        return { ok: true, summary: `Drafted a ${a.currency.toUpperCase()} ${total.toFixed(2)} invoice in Stripe. Review and send it from Stripe.`, refs: [], data: r };
      });
    },
    preview: (a) => ({
      title: 'Draft a Stripe invoice',
      lines: [a.customerId, ...a.items.map((i: { description: string; amount: number }) => `${i.description}: ${a.currency.toUpperCase()} ${i.amount.toFixed(2)}`), 'Stays a draft; not sent or charged'],
    }),
  } satisfies ToolDef<any>,
};

