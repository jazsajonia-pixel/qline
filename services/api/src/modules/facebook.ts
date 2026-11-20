import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import { withTenant, type Q } from '../core/db';
import { ApiError, badRequest, notFound } from '../core/errors';
import { safeError, trackExternal, UNKNOWN_SUMMARY } from '../core/external';
import { open, seal } from '../core/secrets';
import { readLimitedForm } from '../core/upload';
import { body, query } from '../core/validate';
import {
  canPublish,
  checkDraft,
  deleteRemote,
  detectVideo,
  FacebookError,
  facebookMessage,
  FB_PHOTO_MAX_BYTES,
  listPages,
  postState,
  publishPost,
  type PostKind,
} from '../integrations/facebook';
import { getApp } from '../integrations/oauth';
import { enqueue, registerJob, type JobCtx } from '../runtime/jobs';
import { detectImage } from './files';
import { getObject, MAX_FILE_BYTES, putObject } from './imports';
import { notify } from './work';

/**
 * v1.11 Facebook Pages (docs/27).
 * - Pages come from the organization's Facebook connection; each Page token is sealed per organization and Page.
 * - Nothing is posted without an explicit approval of the exact content:
 *     people: the app shows a preview with a content hash, and the post is sent only with confirm=true and that same hash;
 *     the AI: facebook.post is L3 and ALWAYS_ASK (no autonomy level skips it), pinned to the same hash.
 * - The intent is committed before the Graph call. A call with no clear answer is recorded as "unknown" and never retried.
 * - Scheduled posts and videos are reconciled by jobs; people see published / scheduled / processing / failed.
 */

const pageAad = (orgId: string, pageId: string) => `facebook-page:${orgId}:${pageId}`;

export async function facebookApp(): Promise<{ clientId: string; clientSecret: string }> {
  const app = await getApp('facebook');
  if (!app) throw new ApiError(409, 'INTEGRATION_NOT_REGISTERED', "Facebook isn't set up yet", 'The app owner needs to register the Meta app once (Settings → Integration setup).');
  return app;
}

export const publicPage = (p: any) => ({
  id: p.id,
  pageId: p.page_id,
  name: p.name,
  category: p.category,
  pictureUrl: p.picture_url,
  canPost: p.status === 'ok' && !!p.token_ciphertext,
  status: p.status,
  syncedAt: p.synced_at,
});

export const publicPost = (r: any) => ({
  id: r.id,
  pageRef: r.page_ref,
  pageName: r.page_name ?? null,
  kind: r.kind,
  message: r.message,
  link: r.link,
  title: r.title,
  mediaName: r.media_name,
  scheduleAt: r.schedule_at,
  status: r.status,
  source: r.source,
  permalink: r.permalink,
  errorKind: r.error_kind,
  error: r.error,
  createdAt: r.created_at,
  publishedAt: r.published_at,
});

/** Reads the Pages the connected person can act on and stores their tokens (sealed). Pages that disappeared are marked removed. */
export async function syncPages(q: Q, orgId: string, connectionId: string, userToken: string, secret: string) {
  const pages = await listPages(userToken, secret);
  for (const p of pages) {
    const ok = canPublish(p.tasks);
    await q.exec(
      `insert into facebook_pages (org_id, connection_id, page_id, name, category, picture_url, tasks, token_ciphertext, status, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       on conflict (org_id, page_id) do update set connection_id=excluded.connection_id, name=excluded.name, category=excluded.category,
         picture_url=excluded.picture_url, tasks=excluded.tasks, token_ciphertext=excluded.token_ciphertext, status=excluded.status,
         synced_at=now(), updated_at=now()`,
      [orgId, connectionId, p.id, p.name, p.category, p.pictureUrl, p.tasks, ok ? seal(p.accessToken, pageAad(orgId, p.id)) : null, ok ? 'ok' : 'no_access'],
    );
  }
  await q.exec(`update facebook_pages set status='removed', token_ciphertext=null, updated_at=now() where not (page_id = any($1)) and status <> 'removed'`, [pages.map((p) => p.id)]);
  return { pages: pages.length, canPost: pages.filter((p) => canPublish(p.tasks)).length };
}

/** On disconnect: forget every Page token. Post history stays. */
export async function forgetPages(q: Q) {
  await q.exec(`update facebook_pages set token_ciphertext=null, status='removed', updated_at=now() where status <> 'removed' or token_ciphertext is not null`);
}

function pageToken(orgId: string, page: any): string {
  if (!page.token_ciphertext || page.status !== 'ok') throw new FacebookError('No page token', 'permission', 403);
  return open(page.token_ciphertext, pageAad(orgId, page.page_id));
}

// ---- Drafts -----------------------------------------------------------------------------------

export const draftInput = z.object({
  pageRef: z.string().uuid(),
  kind: z.enum(['text', 'link', 'photo', 'video']),
  message: z.string().max(5000).default(''),
  link: z.string().trim().max(2000).optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  fileId: z.string().uuid().optional().nullable(),
  scheduleAt: z.string().datetime({ offset: true }).optional().nullable(),
});
export type DraftInput = z.infer<typeof draftInput>;

export interface Resolved {
  page: any;
  file: { id: string; name: string; mime: string; size_bytes: number; sha256: string; storage_key: string } | null;
  input: DraftInput;
  hash: string;
  preview: { title: string; lines: string[] };
}

export function contentHash(page: { id: string; page_id: string }, d: DraftInput, fileSha: string | null) {
  const at = d.scheduleAt ? new Date(d.scheduleAt).toISOString() : null;
  return createHash('sha256')
    .update(JSON.stringify(['fb.v1', page.id, page.page_id, d.kind, d.message.trim(), d.kind === 'link' ? d.link ?? null : null, d.kind === 'video' ? d.title ?? null : null, fileSha, at]))
    .digest('hex');
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) + ' (Manila time)';

/** Checks a draft against the Page, the file and Facebook's rules. Returns the exact content hash to approve. */
export async function resolveDraft(q: Q, workspaceId: string, input: DraftInput, now = Date.now()): Promise<Resolved | { error: string }> {
  const page = await q.one('select * from facebook_pages where id=$1', [input.pageRef]);
  if (!page) return { error: 'That Facebook Page is not connected. Connect Facebook in Settings → Integrations, then pick a Page.' };
  if (page.status !== 'ok' || !page.token_ciphertext)
    return { error: page.status === 'no_access' ? `You cannot create posts on ${page.name}. Ask a Page admin for content access, then reconnect Facebook.` : `${page.name} is no longer available to Qline. Reconnect Facebook.` };
  const needsFile = input.kind === 'photo' || input.kind === 'video';
  let file: Resolved['file'] = null;
  if (needsFile) {
    if (!input.fileId) return { error: input.kind === 'photo' ? 'Choose a photo for a photo post.' : 'Choose a video for a video post.' };
    file = await q.one('select id, name, mime, size_bytes, sha256, storage_key from files where id=$1 and workspace_id=$2', [input.fileId, workspaceId]);
    if (!file) return { error: 'That file was not found in this workspace.' };
  }
  const problem = checkDraft(
    { kind: input.kind as PostKind, message: input.message, link: input.link ?? null, title: input.title ?? null, scheduleAt: input.scheduleAt ? new Date(input.scheduleAt) : null, mediaMime: file?.mime ?? null, mediaBytes: file?.size_bytes ?? null },
    now,
  );
  if (problem) return { error: problem };
  const clean: DraftInput = { ...input, message: input.message.trim(), link: input.kind === 'link' ? input.link ?? null : null, title: input.kind === 'video' ? input.title ?? null : null, fileId: needsFile ? input.fileId ?? null : null };
  const hash = contentHash(page, clean, file?.sha256 ?? null);
  const what = { text: 'post', link: 'link post', photo: 'photo post', video: 'video post' }[input.kind];
  const title = clean.scheduleAt ? `Schedule a Facebook ${what} on ${page.name}` : `Publish a Facebook ${what} on ${page.name}`;
  const lines = [
    `Page: ${page.name}`,
    clean.scheduleAt ? `Goes live: ${fmtTime(clean.scheduleAt)}` : 'Goes live: right after approval',
    ...(clean.message ? [`Text: ${clean.message}`] : []),
    ...(clean.link ? [`Link: ${clean.link}`] : []),
    ...(clean.title ? [`Video title: ${clean.title}`] : []),
    ...(file ? [`${input.kind === 'photo' ? 'Photo' : 'Video'}: ${file.name} (${(file.size_bytes / 1024 / 1024).toFixed(1)} MB)`] : []),
    'Visible to everyone who can see the Page.',
  ];
  return { page, file, input: clean, hash, preview: { title, lines } };
}

// ---- Publishing -------------------------------------------------------------------------------

export interface PublishBy {
  orgId: string;
  workspaceId: string;
  actorKind: 'user' | 'agent';
  actorId: string;
  /** Who gets the "published / failed" notification. */
  notifyUser: string | null;
  source: 'user' | 'agent';
  requestKey: string;
  approvalId?: string | null;
  toolCallId?: string | null;
}

const sys = (orgId: string, who = 'system:facebook') => ({ orgId, userId: who });

/**
 * Commits the intent, sends the post, records the answer. Idempotent per requestKey (a double tap returns the first
 * attempt). Unclear outcomes are "unknown" and never retried. Returns the stored post.
 */
export async function publishResolved(r: Resolved, by: PublishBy): Promise<any> {
  const started = await withTenant(sys(by.orgId, by.actorId), async (q) => {
    const row = await q.one(
      `insert into facebook_posts (org_id, workspace_id, page_ref, kind, message, link, title, file_id, media_name, media_mime, media_bytes, schedule_at,
         content_hash, status, source, request_key, approval_id, tool_call_id, created_by, notify_user)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'publishing',$14,$15,$16,$17,$18,$19)
       on conflict (org_id, request_key) do nothing returning *`,
      [
        by.orgId, by.workspaceId, r.page.id, r.input.kind, r.input.message, r.input.link ?? null, r.input.title ?? null, r.file?.id ?? null, r.file?.name ?? null,
        r.file?.mime ?? null, r.file?.size_bytes ?? null, r.input.scheduleAt ?? null, r.hash, by.source, by.requestKey, by.approvalId ?? null, by.toolCallId ?? null, by.actorId, by.notifyUser,
      ],
    );
    if (!row) return { existing: await q.one('select * from facebook_posts where request_key=$1', [by.requestKey]) };
    await audit(q, { orgId: by.orgId, actorKind: by.actorKind, actorId: by.actorId, action: 'facebook.post_requested', targetRef: `facebook_post:${row.id}`, detail: { page: r.page.page_id, kind: r.input.kind, scheduled: !!r.input.scheduleAt, hash: r.hash } });
    return { row };
  });
  if ('existing' in started) return started.existing;
  const row = started.row;

  const app = await facebookApp();
  const tracked = await trackExternal(async () => {
    const media = r.file ? { bytes: await getObject(r.file.storage_key), mime: r.file.mime, name: r.file.name } : null;
    if (r.file && media && createHash('sha256').update(media.bytes).digest('hex') !== r.file.sha256) throw new FacebookError('The file changed after it was approved.', 'invalid', 400);
    return publishPost(r.page.page_id, pageToken(by.orgId, r.page), app.clientSecret, {
      kind: r.input.kind as PostKind,
      message: r.input.message,
      link: r.input.link,
      title: r.input.title,
      scheduleAt: r.input.scheduleAt ? new Date(r.input.scheduleAt) : null,
      media,
    });
  });

  return withTenant(sys(by.orgId, by.actorId), async (q) => {
    if (tracked.ok) {
      const res = tracked.value;
      const status = r.input.scheduleAt ? 'scheduled' : r.input.kind === 'video' ? 'processing' : 'published';
      const out = await q.one(
        `update facebook_posts set status=$2, fb_object_id=$3, fb_post_id=$4, published_at=case when $2='published' then now() end, updated_at=now() where id=$1 returning *`,
        [row.id, status, res.objectId, res.postId],
      );
      await audit(q, { orgId: by.orgId, actorKind: by.actorKind, actorId: by.actorId, action: `facebook.post_${status}`, targetRef: `facebook_post:${row.id}`, detail: { page: r.page.page_id, object: res.objectId } });
      // Check the result: a scheduled post just after its time, a video once Facebook has processed it, a post to get its link.
      const runAt = r.input.scheduleAt ? new Date(new Date(r.input.scheduleAt).getTime() + 2 * 60_000) : new Date(Date.now() + (r.input.kind === 'video' ? 90_000 : 15_000));
      await enqueue(q, { orgId: by.orgId, kind: 'facebook.reconcile', payload: { postId: row.id, workspaceId: by.workspaceId, n: 0 }, idempotencyKey: `fb-reconcile:${row.id}:0`, runAt, createdBy: 'system:facebook', maxAttempts: 3 });
      return out;
    }
    const e = tracked.error;
    const fb = e instanceof FacebookError ? e : null;
    // A clear refusal from Facebook (or a problem before anything was sent) is "failed"; anything else is "unknown".
    const definite = tracked.outcome === 'failed' || (fb !== null && fb.status >= 400 && fb.status < 500);
    const status = definite ? 'failed' : 'unknown';
    const message = fb ? facebookMessage(fb) : definite ? safeError(e) : UNKNOWN_SUMMARY;
    if (fb?.kind === 'reconnect') {
      await q.exec(`update integration_connections set status='expired', status_detail=$1, updated_at=now() where provider='facebook'`, [message]);
    }
    const out = await q.one(`update facebook_posts set status=$2, error_kind=$3, error=$4, updated_at=now() where id=$1 returning *`, [row.id, status, fb?.kind ?? (definite ? 'invalid' : 'unknown'), message]);
    await audit(q, { orgId: by.orgId, actorKind: by.actorKind, actorId: by.actorId, action: `facebook.post_${status}`, targetRef: `facebook_post:${row.id}`, outcome: 'failure', detail: { page: r.page.page_id, kind: fb?.kind ?? null, code: fb?.code ?? null } });
    return out;
  });
}

// ---- Reconciliation ---------------------------------------------------------------------------

/** Brings one post up to date with Facebook. Safe to call any time; only open posts are read. */
export async function refreshPost(orgId: string, postId: string): Promise<any> {
  const row = await withTenant(sys(orgId), (q) => q.one('select p.*, g.page_id as fb_page_id, g.token_ciphertext, g.status as page_status, g.name as page_name from facebook_posts p join facebook_pages g on g.id=p.page_ref where p.id=$1', [postId]));
  if (!row) return null;
  if (!['scheduled', 'processing'].includes(row.status) || !row.fb_object_id) return row;
  const app = await facebookApp();
  let s: Awaited<ReturnType<typeof postState>>;
  try {
    s = await postState(row.fb_object_id, row.kind, pageToken(orgId, { ...row, page_id: row.fb_page_id, status: row.page_status }), app.clientSecret);
  } catch (e) {
    const fb = e instanceof FacebookError ? e : null;
    await withTenant(sys(orgId), (q) => q.exec(`update facebook_posts set last_checked_at=now(), error=$2 where id=$1`, [postId, fb ? facebookMessage(fb) : safeError(e)]));
    throw e;
  }
  return withTenant(sys(orgId), async (q) => {
    const next = s.state === 'published' ? 'published' : s.state === 'failed' ? 'failed' : s.state === 'missing' ? 'cancelled' : row.status === 'processing' && s.state === 'scheduled' ? 'scheduled' : row.status;
    const out = await q.one(
      `update facebook_posts set status=$2, permalink=coalesce($3, permalink), error=case when $2 in ('failed','cancelled') then $4 else null end,
         error_kind=case when $2='failed' then 'invalid' else error_kind end, published_at=case when $2='published' then coalesce(published_at, now()) else published_at end,
         last_checked_at=now(), updated_at=now() where id=$1 returning *`,
      [postId, next, s.permalink, s.detail],
    );
    if (next !== row.status) {
      await audit(q, { orgId, actorKind: 'system', actorId: 'facebook.reconcile', action: `facebook.post_${next}`, targetRef: `facebook_post:${postId}` });
      const who = row.notify_user as string | null;
      if (who && (next === 'published' || next === 'failed')) {
        await notify(q, orgId, who, { category: 'facebook', title: next === 'published' ? `Posted on ${row.page_name}` : `Facebook post failed on ${row.page_name}`, body: next === 'failed' ? s.detail ?? undefined : undefined, ref: { facebookPost: postId } });
      }
    }
    return { ...out, page_name: row.page_name };
  });
}

registerJob('facebook.reconcile', async (ctx: JobCtx) => {
  const { postId, workspaceId } = ctx.job.payload as { postId: string; workspaceId: string; n: number };
  const n = Number(ctx.job.payload.n ?? 0);
  const row = await refreshPost(ctx.job.org_id, postId);
  if (row && ['scheduled', 'processing'].includes(row.status) && n < 12) {
    // Still open: check again (every 10 minutes, at most 12 times past the expected time).
    await withTenant(sys(ctx.job.org_id), (q) =>
      enqueue(q, { orgId: ctx.job.org_id, kind: 'facebook.reconcile', payload: { postId, workspaceId, n: n + 1 }, idempotencyKey: `fb-reconcile:${postId}:${n + 1}`, runAt: new Date(Date.now() + 10 * 60_000), createdBy: 'system:facebook', maxAttempts: 3 }),
    );
  }
  return { status: row?.status ?? 'missing' };
});

// ---- Routes -----------------------------------------------------------------------------------

export const facebookRoutes = new Hono<Env>();

const withPage = `select p.*, g.name as page_name from facebook_posts p join facebook_pages g on g.id=p.page_ref`;

facebookRoutes.get('/facebook/pages', async (c) => {
  const t = need(c, 'tasks.read');
  const [pages, conn] = await tx(t, async (q) => [await q.many(`select * from facebook_pages where status <> 'removed' order by name`), await q.one(`select status, status_detail, account_name, scopes from integration_connections where provider='facebook'`)] as const);
  return c.json({
    connected: !!conn,
    connection: conn ? { status: conn.status, statusDetail: conn.status_detail, accountName: conn.account_name, canPostVideo: (conn.scopes as string[]).includes('publish_video') } : null,
    pages: pages.map(publicPage),
  });
});

facebookRoutes.post('/facebook/pages/sync', async (c) => {
  const t = need(c, 'integrations.manage');
  const app = await facebookApp();
  const out = await tx(t, async (q) => {
    const conn = await q.one(`select * from integration_connections where provider='facebook'`);
    if (!conn) throw new ApiError(409, 'FACEBOOK_NOT_CONNECTED', 'Facebook is not connected', 'Connect Facebook in Settings → Integrations first.');
    const tok = JSON.parse(open(conn.token_ciphertext, `oauth:${t.orgId}:facebook`));
    try {
      return await syncPages(q, t.orgId, conn.id, tok.access_token, app.clientSecret);
    } catch (e) {
      if (e instanceof FacebookError) throw new ApiError(e.kind === 'reconnect' ? 409 : 502, `FACEBOOK_${e.kind.toUpperCase()}`, 'Facebook did not answer as expected', facebookMessage(e));
      throw e;
    }
  });
  return c.json(out);
});

facebookRoutes.get('/facebook/posts', async (c) => {
  const t = need(c, 'tasks.read');
  const { limit } = query(c, z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }));
  const [posts, waiting] = await tx(t, async (q) => [
    await q.many(`${withPage} where p.workspace_id=$1 order by p.created_at desc limit $2`, [t.workspaceId, limit]),
    // AI-written posts that are still waiting in Approvals.
    await q.many(`select id, preview, created_at, expires_at from approval_requests where workspace_id=$1 and action='facebook.post' and status='pending' order by created_at desc limit 20`, [t.workspaceId]),
  ] as const);
  return c.json({
    posts: posts.map(publicPost),
    awaitingApproval: waiting.map((a: any) => ({ approvalId: a.id, title: a.preview?.title ?? 'Facebook post', lines: a.preview?.lines ?? [], createdAt: a.created_at, expiresAt: a.expires_at })),
  });
});

facebookRoutes.post('/facebook/posts/preview', async (c) => {
  const t = need(c, 'contacts.write');
  const input = await body(c, draftInput);
  const r = await tx(t, (q) => resolveDraft(q, t.workspaceId, input));
  if ('error' in r) throw new ApiError(400, 'FACEBOOK_POST_INVALID', 'This post cannot be sent yet', r.error);
  return c.json({ contentHash: r.hash, preview: r.preview, page: publicPage(r.page) });
});

/** The person's explicit approval: confirm=true and the hash of the preview they saw. Anything changed → 409. */
facebookRoutes.post('/facebook/posts', async (c) => {
  const t = need(c, 'contacts.write');
  if (!t.human || c.req.header('x-qline-service')) throw new ApiError(403, 'FORBIDDEN', 'Only a person can approve a Facebook post.');
  const input = await body(c, draftInput.extend({ confirm: z.literal(true), contentHash: z.string().regex(/^[0-9a-f]{64}$/), requestKey: z.string().min(8).max(100) }));
  const r = await tx(t, (q) => resolveDraft(q, t.workspaceId, input));
  if ('error' in r) throw new ApiError(400, 'FACEBOOK_POST_INVALID', 'This post cannot be sent', r.error);
  if (r.hash !== input.contentHash) throw new ApiError(409, 'FACEBOOK_POST_CHANGED', 'The post changed', 'Something changed after you reviewed it (text, Page, file or time). Review it again before posting.');
  const row = await publishResolved(r, { orgId: t.orgId, workspaceId: t.workspaceId, actorKind: 'user', actorId: t.userId, notifyUser: t.userId, source: 'user', requestKey: `user:${t.userId}:${input.requestKey}` });
  return c.json({ post: publicPost({ ...row, page_name: r.page.name }) }, row.status === 'failed' ? 422 : 201);
});

facebookRoutes.get('/facebook/posts/:id', async (c) => {
  const t = need(c, 'tasks.read');
  const id = c.req.param('id');
  const row = await tx(t, (q) => q.one(`${withPage} where p.id=$1 and p.workspace_id=$2`, [id, t.workspaceId]));
  if (!row) throw notFound('Facebook post');
  const fresh = ['scheduled', 'processing'].includes(row.status) ? await refreshPost(t.orgId, id).catch(() => row) : row;
  return c.json({ post: publicPost({ ...fresh, page_name: row.page_name }) });
});

/** Cancels a post that is still scheduled: removes it from Facebook, keeps the record as cancelled. */
facebookRoutes.post('/facebook/posts/:id/cancel', async (c) => {
  const t = need(c, 'contacts.write');
  await body(c, z.object({ confirm: z.literal(true) }));
  const id = c.req.param('id');
  const row = await tx(t, (q) => q.one(`select p.*, g.page_id as fb_page_id, g.token_ciphertext, g.status as page_status, g.name as page_name from facebook_posts p join facebook_pages g on g.id=p.page_ref where p.id=$1 and p.workspace_id=$2`, [id, t.workspaceId]));
  if (!row) throw notFound('Facebook post');
  if (row.status !== 'scheduled' || !row.fb_object_id) throw new ApiError(409, 'FACEBOOK_NOT_SCHEDULED', 'Only scheduled posts can be cancelled', row.status === 'published' ? 'This post is already live. Delete it on Facebook if you need to.' : `This post is ${row.status}.`);
  if (row.schedule_at && new Date(row.schedule_at).getTime() < Date.now() + 60_000) throw new ApiError(409, 'FACEBOOK_TOO_LATE', 'Too close to go-live', 'This post goes live within a minute, so it can no longer be cancelled safely.');
  const app = await facebookApp();
  try {
    await deleteRemote(row.fb_object_id, pageToken(t.orgId, { ...row, page_id: row.fb_page_id, status: row.page_status }), app.clientSecret);
  } catch (e) {
    if (e instanceof FacebookError) throw new ApiError(e.kind === 'reconnect' ? 409 : 502, `FACEBOOK_${e.kind.toUpperCase()}`, 'Facebook did not cancel the post', facebookMessage(e));
    throw e;
  }
  const out = await tx(t, async (q) => {
    const r = await q.one(`update facebook_posts set status='cancelled', updated_at=now() where id=$1 returning *`, [id]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'facebook.post_cancelled', targetRef: `facebook_post:${id}` });
    return r;
  });
  return c.json({ post: publicPost({ ...out, page_name: row.page_name }) });
});

/** Photo or video for a post (10 MB, the request budget). Type from magic bytes; stored privately as a 'social' file. */
facebookRoutes.post('/facebook/media', async (c) => {
  const t = need(c, 'contacts.write');
  const form = await readLimitedForm(c.req.raw, MAX_FILE_BYTES + 64 * 1024, 'The limit is 10 MB per photo or video.');
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw badRequest('Send the file as multipart field "file".');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw badRequest('The file is empty.');
  if (bytes.length > MAX_FILE_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'File too large', 'The limit is 10 MB per photo or video.');
  const img = detectImage(bytes);
  const vid = img ? null : detectVideo(bytes);
  const mime = img ?? vid;
  if (!mime) throw badRequest('Choose a JPEG, PNG or GIF photo, or an MP4 or MOV video.');
  if (mime === 'image/webp') throw badRequest('Facebook does not take WebP photos. Choose a JPEG, PNG or GIF.');
  if (img && bytes.length > FB_PHOTO_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Photo too large', 'Facebook photos must be 10 MB or smaller.');
  const safeName = file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || (img ? 'photo' : 'video');
  const id = randomUUID();
  const key = `org/${t.orgId}/ws/${t.workspaceId}/social/${id}`;
  await putObject(key, bytes, mime);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const row = await tx(t, async (q) => {
    const f = await q.one(
      `insert into files (id, org_id, workspace_id, name, mime, size_bytes, sha256, storage_key, created_by, source, extracted)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'social',$10) returning id, name, mime, size_bytes, created_at`,
      [id, t.orgId, t.workspaceId, safeName, mime, bytes.length, sha, key, t.userId, JSON.stringify(img ? { kind: 'image' } : { kind: 'document', text: '', chars: 0, note: 'Video for a Facebook post' })],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'file.uploaded', targetRef: `file:${id}`, detail: { name: safeName, kind: img ? 'photo' : 'video', size: bytes.length, for: 'facebook' } });
    return f;
  });
  return c.json({ ...row, kind: img ? 'photo' : 'video' }, 201);
});

