import { createHmac } from 'node:crypto';
import { noteRequest } from '../core/external';

/**
 * v1.11 Facebook Pages (docs/27). Graph API calls for Page connection, publishing and status.
 * - Only Facebook Pages. No Instagram, groups or personal profiles.
 * - Every call carries appsecret_proof, so a leaked token alone cannot be replayed from elsewhere when the Meta app
 *   has "Require App Secret" on (recommended in docs/27).
 * - Media goes to Meta as a multipart upload of the bytes Qline already stores. Qline never exposes a public URL.
 * - Errors are classified so people get one plain answer: reconnect, missing permission, slow down, or fix the post.
 */

export const GRAPH_VERSION = 'v27.0';
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VERSION}`;
export const FB_DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

/** Permissions Qline asks for. publish_video is only needed for video posts. */
export const FB_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] as const;
export const FB_VIDEO_SCOPE = 'publish_video';

/** Meta: scheduled posts go live between 10 minutes and 30 days (feed) after the request. Qline uses that for every kind. */
export const SCHEDULE_MIN_MS = 10 * 60_000;
export const SCHEDULE_MAX_MS = 30 * 24 * 3600_000;
/** A small margin so a post approved just inside the window is not rejected by the time it reaches Meta. */
export const SCHEDULE_MARGIN_MS = 60_000;

export const FB_PHOTO_MAX_BYTES = 10 * 1024 * 1024; // Meta's photo limit (and Qline's upload limit)
export const FB_MESSAGE_MAX = 5000;
export const FB_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/gif'] as const;
export const FB_VIDEO_MIMES = ['video/mp4', 'video/quicktime'] as const;

export type FbErrorKind = 'reconnect' | 'permission' | 'rate_limit' | 'blocked' | 'duplicate' | 'invalid' | 'unavailable';

export class FacebookError extends Error {
  constructor(
    message: string,
    public kind: FbErrorKind,
    public status: number,
    public code: number | null = null,
    public subcode: number | null = null,
  ) {
    super(message);
  }
}

/** Graph error codes → what the person should do. https://developers.facebook.com/docs/graph-api/guides/error-handling */
export function classifyGraphError(status: number, body: any): FacebookError {
  const err = body?.error ?? {};
  const code = typeof err.code === 'number' ? err.code : null;
  const sub = typeof err.error_subcode === 'number' ? err.error_subcode : null;
  const raw = String(err.error_user_msg ?? err.message ?? `HTTP ${status}`).slice(0, 300);
  let kind: FbErrorKind;
  if (code === 190 || code === 102 || (code === null && status === 401)) kind = 'reconnect';
  else if (code === 10 || (code !== null && code >= 200 && code <= 299) || status === 403) kind = 'permission';
  else if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== null && code >= 80000 && code <= 80099) || status === 429) kind = 'rate_limit';
  else if (code === 368) kind = 'blocked';
  else if (code === 506) kind = 'duplicate';
  else if (code === 1 || code === 2 || status >= 500 || status === 0) kind = 'unavailable';
  else kind = 'invalid';
  return new FacebookError(raw, kind, status, code, sub);
}

/** One sentence a person can act on. The Graph message is kept as detail only for 'invalid'. */
export function facebookMessage(e: FacebookError): string {
  switch (e.kind) {
    case 'reconnect':
      return 'Facebook ended this connection (the login expired, the password changed or access was removed). Reconnect Facebook in Settings → Integrations.';
    case 'permission':
      return 'Facebook refused because a permission is missing. Reconnect Facebook and allow Qline to manage posts on the Page, and check that you can create content on that Page.';
    case 'rate_limit':
      return 'Facebook is limiting requests for this Page right now. Wait a few minutes and try again.';
    case 'blocked':
      return 'Facebook has temporarily blocked posting from this account or Page. Check Facebook for a notice before trying again.';
    case 'duplicate':
      return 'Facebook rejected this as a duplicate of a recent post. Change the text before posting again.';
    case 'unavailable':
      return 'Facebook is not answering right now. Try again shortly.';
    default:
      return `Facebook did not accept this post: ${e.message}`;
  }
}

export const appsecretProof = (token: string, secret: string) => createHmac('sha256', secret).update(token).digest('hex');

export interface GraphOpts {
  secret: string;
  method?: 'GET' | 'POST' | 'DELETE';
  params?: Record<string, string | number | boolean | undefined | null>;
  form?: FormData;
  host?: string;
  timeoutMs?: number;
  /** For tests: a stand-in for fetch. */
  fetchImpl?: typeof fetch;
}

let testFetch: typeof fetch | null = null;
/** Tests only: route Graph calls to a stub. */
export function setFacebookFetch(f: typeof fetch | null) {
  testFetch = f;
}

/** A Graph call. GET params go in the query; POST params go in a form body (or the multipart form when given). */
export async function graph(path: string, token: string, o: GraphOpts): Promise<any> {
  const method = o.method ?? 'GET';
  const url = new URL(`${o.host ?? GRAPH}${path.startsWith('/') ? path : `/${path}`}`);
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.params ?? {})) if (v !== undefined && v !== null) params[k] = String(v);
  params.access_token = token;
  params.appsecret_proof = appsecretProof(token, o.secret);
  let body: BodyInit | undefined;
  if (method === 'GET' || method === 'DELETE') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else if (o.form) {
    for (const [k, v] of Object.entries(params)) o.form.set(k, v);
    body = o.form;
  } else {
    body = new URLSearchParams(params);
  }
  const answered = noteRequest(method);
  const f = o.fetchImpl ?? testFetch ?? fetch;
  let r: Response;
  try {
    r = await f(url.toString(), { method, body, signal: AbortSignal.timeout(o.timeoutMs ?? 30_000), headers: { accept: 'application/json' } });
  } catch (e) {
    answered(null); // no answer: a POST may have reached Facebook
    throw e;
  }
  const text = await r.text().catch(() => '');
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  const failed = !r.ok || !!j?.error;
  answered(r.status, !failed);
  if (failed) throw classifyGraphError(r.status, j);
  return j;
}

// ---- Login ------------------------------------------------------------------------------------

/** The authorization-code exchange (called by the shared OAuth code). Same shape as the other providers' token calls. */
export async function fbTokenRequest(form: Record<string, string>): Promise<{ ok: boolean; status: number; body: any }> {
  let r: Response;
  try {
    r = await (testFetch ?? fetch)(`${GRAPH}/oauth/access_token`, {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form),
    });
  } catch {
    return { ok: false, status: 0, body: { error: 'network_error' } };
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.error) return { ok: false, status: r.status, body: { error: j?.error?.type ?? 'facebook_error', error_description: j?.error?.message ?? `HTTP ${r.status}` } };
  return { ok: true, status: r.status, body: j };
}

export interface FbApp {
  clientId: string;
  clientSecret: string;
}

/** Short-lived (about 1 hour) user token → long-lived (about 60 days). Page tokens read with it do not expire. */
export async function longLivedUserToken(app: FbApp, shortToken: string): Promise<{ access_token: string; expires_at: number | null }> {
  const j = await graph('/oauth/access_token', shortToken, {
    secret: app.clientSecret,
    params: { grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: shortToken },
  });
  return { access_token: j.access_token, expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null };
}

/** What the person actually granted (they can untick permissions on the Facebook dialog). */
export async function grantedPermissions(token: string, secret: string): Promise<string[]> {
  const j = await graph('/me/permissions', token, { secret });
  return ((j?.data ?? []) as { permission: string; status: string }[]).filter((p) => p.status === 'granted').map((p) => p.permission);
}

export async function fbMe(token: string, secret: string): Promise<{ id: string; name: string | null }> {
  const j = await graph('/me', token, { secret, params: { fields: 'id,name' } });
  return { id: String(j.id), name: j.name ?? null };
}

export interface FbPage {
  id: string;
  name: string;
  category: string | null;
  tasks: string[];
  accessToken: string;
  pictureUrl: string | null;
}

/** Pages the person can act on, with a Page token for each. Bounded to 300 Pages. */
export async function listPages(userToken: string, secret: string): Promise<FbPage[]> {
  const out: FbPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < 3; i++) {
    const j = await graph('/me/accounts', userToken, { secret, params: { fields: 'id,name,category,tasks,access_token,picture{url}', limit: 100, after } });
    for (const p of j?.data ?? []) {
      if (!p?.id || !p.access_token) continue;
      out.push({ id: String(p.id), name: String(p.name ?? 'Facebook Page').slice(0, 200), category: p.category ?? null, tasks: Array.isArray(p.tasks) ? p.tasks.map(String) : [], accessToken: p.access_token, pictureUrl: p.picture?.data?.url ?? null });
    }
    after = j?.paging?.next ? j?.paging?.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

/** Meta requires the CREATE_CONTENT task on the Page to publish (MANAGE includes it in practice; Qline checks the task). */
export const canPublish = (tasks: string[]) => tasks.includes('CREATE_CONTENT') || tasks.includes('MANAGE');

// ---- Posts ------------------------------------------------------------------------------------

export type PostKind = 'text' | 'link' | 'photo' | 'video';

export interface PostDraft {
  kind: PostKind;
  message: string;
  link?: string | null;
  title?: string | null;
  scheduleAt?: Date | null;
  media?: { bytes: Uint8Array; mime: string; name: string } | null;
}

/** Problems Qline can catch before asking anyone to approve. Returns a plain sentence or null. */
export function checkDraft(d: Omit<PostDraft, 'media'> & { mediaMime?: string | null; mediaBytes?: number | null }, now = Date.now()): string | null {
  const msg = d.message.trim();
  if (d.kind === 'text' && !msg) return 'Write the post text first.';
  if (msg.length > FB_MESSAGE_MAX) return `Keep the post under ${FB_MESSAGE_MAX} characters.`;
  if (d.kind === 'link') {
    if (!d.link) return 'Add the link to share.';
    try {
      const u = new URL(d.link);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Links must start with https://.';
    } catch {
      return 'That link is not a valid web address.';
    }
  }
  if (d.kind === 'photo') {
    if (!d.mediaMime) return 'Choose a photo for a photo post.';
    if (!(FB_PHOTO_MIMES as readonly string[]).includes(d.mediaMime)) return 'Facebook takes JPEG, PNG or GIF photos.';
    if ((d.mediaBytes ?? 0) > FB_PHOTO_MAX_BYTES) return 'Facebook photos must be 10 MB or smaller.';
  }
  if (d.kind === 'video') {
    if (!d.mediaMime) return 'Choose a video for a video post.';
    if (!(FB_VIDEO_MIMES as readonly string[]).includes(d.mediaMime)) return 'Qline posts MP4 or MOV videos.';
  }
  if (d.scheduleAt) {
    const ms = d.scheduleAt.getTime() - now;
    if (!Number.isFinite(ms)) return 'That schedule time is not valid.';
    if (ms < SCHEDULE_MIN_MS + SCHEDULE_MARGIN_MS) return 'Facebook needs scheduled posts to be at least 10 minutes away. Pick a later time (11 minutes or more).';
    if (ms > SCHEDULE_MAX_MS) return 'Facebook schedules posts up to 30 days ahead. Pick an earlier time.';
  }
  return null;
}

export interface Published {
  /** The id to read status with: the post id (feed, photo post) or the video id. */
  objectId: string;
  /** The Page post id when Facebook returns one (feed and photos). */
  postId: string | null;
}

/** Publishes now, or schedules when scheduleAt is set. Throws FacebookError. */
export async function publishPost(pageId: string, pageToken: string, secret: string, d: PostDraft): Promise<Published> {
  const sched = d.scheduleAt ? { published: false, scheduled_publish_time: Math.floor(d.scheduleAt.getTime() / 1000) } : {};
  if (d.kind === 'text' || d.kind === 'link') {
    const j = await graph(`/${pageId}/feed`, pageToken, { secret, method: 'POST', params: { message: d.message || undefined, link: d.kind === 'link' ? d.link : undefined, ...sched } });
    return { objectId: String(j.id), postId: String(j.id) };
  }
  if (!d.media) throw new FacebookError('Media missing', 'invalid', 400);
  const form = new FormData();
  form.set('source', new Blob([new Uint8Array(d.media.bytes)], { type: d.media.mime }), d.media.name);
  if (d.kind === 'photo') {
    const j = await graph(`/${pageId}/photos`, pageToken, { secret, method: 'POST', form, params: { caption: d.message || undefined, ...sched }, timeoutMs: 60_000 });
    return { objectId: String(j.post_id ?? j.id), postId: j.post_id ? String(j.post_id) : null };
  }
  const j = await graph(`/${pageId}/videos`, pageToken, {
    secret,
    method: 'POST',
    host: GRAPH_VIDEO,
    form,
    params: { description: d.message || undefined, title: d.title || undefined, ...sched },
    timeoutMs: 120_000,
  });
  return { objectId: String(j.id), postId: null };
}

export type RemoteState = 'published' | 'scheduled' | 'processing' | 'failed' | 'missing';

/** Reads what Facebook says about a post or video now. */
export async function postState(objectId: string, kind: PostKind, pageToken: string, secret: string): Promise<{ state: RemoteState; permalink: string | null; detail: string | null }> {
  try {
    if (kind === 'video') {
      const j = await graph(`/${objectId}`, pageToken, { secret, params: { fields: 'status,permalink_url,published' } });
      const vs = String(j?.status?.video_status ?? '');
      const pub = String(j?.status?.publishing_phase?.status ?? '');
      const permalink = j?.permalink_url ? (String(j.permalink_url).startsWith('http') ? j.permalink_url : `https://www.facebook.com${j.permalink_url}`) : null;
      if (vs === 'error' || pub === 'error') return { state: 'failed', permalink, detail: j?.status?.processing_phase?.errors?.[0]?.message ?? 'Facebook could not process the video.' };
      if (j?.published) return { state: 'published', permalink, detail: null };
      if (vs === 'processing' || vs === 'upload_complete' || pub === 'not_started' || pub === 'in_progress') return { state: 'processing', permalink, detail: null };
      return { state: 'scheduled', permalink, detail: null };
    }
    const j = await graph(`/${objectId}`, pageToken, { secret, params: { fields: 'id,is_published,permalink_url,scheduled_publish_time' } });
    return { state: j?.is_published === false ? 'scheduled' : 'published', permalink: j?.permalink_url ?? null, detail: null };
  } catch (e) {
    if (e instanceof FacebookError && e.kind === 'invalid' && (e.code === 100 || e.status === 404)) return { state: 'missing', permalink: null, detail: 'Facebook no longer has this post (it may have been deleted on Facebook).' };
    throw e;
  }
}

/** Removes a scheduled (not yet published) post or video from Facebook. */
export async function deleteRemote(objectId: string, pageToken: string, secret: string): Promise<void> {
  await graph(`/${objectId}`, pageToken, { secret, method: 'DELETE' });
}

/** Video type from magic bytes ("ftyp" box at offset 4). qt = QuickTime (MOV). */
export function detectVideo(b: Uint8Array): 'video/mp4' | 'video/quicktime' | null {
  if (b.length < 12 || b[4] !== 0x66 || b[5] !== 0x74 || b[6] !== 0x79 || b[7] !== 0x70) return null;
  const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
  return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
}
