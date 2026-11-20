import { z } from 'zod';
import type { Q } from '../core/db';
import { currentIdempotencyKey } from '../core/external';
import { publicPage, publishResolved, resolveDraft, type DraftInput } from '../modules/facebook';
import { fail } from './tools-apps';
import type { ToolCtx, ToolDef, ToolPreview } from './tools';

/**
 * v1.11 Facebook Pages tools (docs/27). facebook.pages is a read (L0). facebook.post is L3 and ALWAYS_ASK in
 * @qline/policy, so no autonomy level lets the AI post on its own. It is staged first: the content hash of exactly
 * what the person will see (Page, text, link, media file hash, time) is pinned, and checked again when it runs.
 */

type Staged<T> = { ok: true; args: T; preview: ToolPreview } | { ok: false; error: string };
const NOT_STAGED = 'This post was not reviewed in Approvals, so Qline will not publish it. Ask for it again.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Pinned {
  hash: string;
  pageRef: string;
}
const pinned = (a: unknown) => (a as { _pinned?: Pinned })._pinned;

const postSchema = z.object({
  page: z.string().trim().min(1).max(200).describe('The Page id from facebook.pages, or its exact name'),
  kind: z.enum(['text', 'link', 'photo', 'video']).default('text'),
  message: z.string().max(5000).default('').describe('The post text, exactly as it should appear'),
  link: z.string().trim().max(2000).optional().describe('For kind=link: the https:// link to share'),
  fileId: z.string().uuid().optional().describe('For photo or video: a file the person attached (JPEG/PNG/GIF photo or MP4/MOV video)'),
  title: z.string().trim().max(200).optional().describe('For video: the video title'),
  scheduleAt: z.string().datetime({ offset: true }).optional().describe('Optional go-live time with timezone offset (e.g. 2026-11-21T09:00:00+08:00). 11 minutes to 30 days ahead. Leave empty to post right after approval.'),
});
type PostArgs = z.infer<typeof postSchema>;

async function findPage(q: Q, page: string): Promise<any | string> {
  const rows = UUID.test(page)
    ? await q.many(`select * from facebook_pages where id=$1 or page_id=$2`, [page, page])
    : /^[0-9]{1,30}$/.test(page)
      ? await q.many(`select * from facebook_pages where page_id=$1`, [page])
      : await q.many(`select * from facebook_pages where lower(name)=lower($1) and status <> 'removed'`, [page]);
  if (!rows.length) {
    const any = await q.one(`select 1 from facebook_pages where status='ok' limit 1`);
    return any ? `There is no connected Facebook Page called "${page}". Use facebook.pages to see the Pages Qline can post to.` : 'No Facebook Page is connected. Connect Facebook in Settings → Integrations and pick a Page first.';
  }
  if (rows.length > 1) return `More than one Page matches "${page}". Use the Page id from facebook.pages.`;
  return rows[0];
}

const draftOf = (pageRef: string, a: PostArgs): DraftInput => ({ pageRef, kind: a.kind, message: a.message ?? '', link: a.link ?? null, title: a.title ?? null, fileId: a.fileId ?? null, scheduleAt: a.scheduleAt ?? null });

export const facebookTools = {
  'facebook.pages': {
    description: 'List the Facebook Pages connected to Qline and whether Qline can post on each. Facebook Pages only (no Instagram, groups or profiles).',
    schema: z.object({}),
    async execute(q) {
      const rows = await q.many(`select * from facebook_pages where status <> 'removed' order by name`);
      if (!rows.length) return fail('No Facebook Page is connected. Connect Facebook in Settings → Integrations first.');
      return { ok: true, summary: `${rows.length} Facebook Page${rows.length === 1 ? '' : 's'}`, refs: [], data: { pages: rows.map(publicPage) } };
    },
    preview: () => ({ title: 'Read Facebook Pages', lines: [] }),
  } satisfies ToolDef<any>,

  'facebook.post': {
    description:
      'Publish or schedule a post on a connected Facebook Page: text, a link, one photo or one short video (up to 10 MB). Always needs a person to approve the exact post in Approvals, even on full autopilot. Write the final text (no placeholders). Do not use for Instagram or other platforms.',
    schema: postSchema,
    async stage(q: Q, ctx: ToolCtx, a: PostArgs): Promise<Staged<any>> {
      const page = await findPage(q, a.page);
      if (typeof page === 'string') return { ok: false, error: page };
      const r = await resolveDraft(q, ctx.workspaceId, draftOf(page.id, a));
      if ('error' in r) return { ok: false, error: r.error };
      const p: Pinned = { hash: r.hash, pageRef: page.id };
      return { ok: true, args: { ...a, page: page.id, _pinned: p }, preview: r.preview };
    },
    async execute(q, ctx, a) {
      const p = pinned(a);
      if (!p) return fail(NOT_STAGED);
      const r = await resolveDraft(q, ctx.workspaceId, draftOf(p.pageRef, a));
      if ('error' in r) return fail(r.error);
      if (r.hash !== p.hash) return fail('The post changed after it was approved (the Page, file or time is different), so it was not published. Ask for it again.');
      const row = await publishResolved(r, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        actorKind: 'agent',
        actorId: ctx.actor.id,
        notifyUser: ctx.userId,
        source: 'agent',
        requestKey: `agent:${currentIdempotencyKey() ?? `${p.hash}:${Date.now()}`}`,
      });
      const where = r.page.name;
      if (row.status === 'published') return { ok: true, summary: `Posted on ${where}`, refs: [], data: { postId: row.id, status: row.status } };
      if (row.status === 'scheduled') return { ok: true, summary: `Scheduled on ${where} for ${new Date(row.schedule_at).toISOString()}`, refs: [], data: { postId: row.id, status: row.status } };
      if (row.status === 'processing') return { ok: true, summary: `Video uploaded to ${where}; Facebook is processing it`, refs: [], data: { postId: row.id, status: row.status } };
      return fail(row.error ?? `The Facebook post ended as ${row.status}.`);
    },
    preview: (a: PostArgs) => ({ title: a.scheduleAt ? 'Schedule a Facebook post' : 'Publish a Facebook post', lines: [a.message ?? ''].filter(Boolean) }),
  } satisfies ToolDef<any>,
};
