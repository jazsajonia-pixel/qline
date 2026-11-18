import { PROVIDER_TIMEOUT_MS } from './oauth';
import { currentIdempotencyKey, noteRequest } from '../core/external';

/**
 * v1.6 run 3: thin wrappers over the Google Drive, Notion, GitHub and Stripe REST APIs.
 * Every call uses the organization's own token or key, has a timeout, and returns small,
 * model-friendly shapes. Content from these services is always treated as untrusted data.
 */

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call(url: string, init: RequestInit & { timeoutMs?: number }) {
  const answered = noteRequest(init.method);
  // Stripe supports idempotency keys: a repeated request with the same key returns the first result instead of acting twice.
  const idem = currentIdempotencyKey();
  const headers = idem && url.startsWith('https://api.stripe.com/') && (init.method ?? 'GET').toUpperCase() === 'POST' ? { ...(init.headers as Record<string, string>), 'Idempotency-Key': idem } : init.headers;
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(init.timeoutMs ?? PROVIDER_TIMEOUT_MS) });
  } catch (e) {
    answered(null);
    throw e;
  }
  answered(r.status);
  const text = await r.text().catch(() => '');
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  if (!r.ok) {
    const msg = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : null) ?? `HTTP ${r.status}`;
    throw new ProviderHttpError(String(msg).slice(0, 300), r.status);
  }
  return j;
}

const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

// ---- Google Drive ------------------------------------------------------------------------------
const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const GSHEET = 'application/vnd.google-apps.spreadsheet';
const GSLIDES = 'application/vnd.google-apps.presentation';
export const DRIVE_READ_MAX_BYTES = 10 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  owners?: string[];
}

const driveFields = 'id,name,mimeType,modifiedTime,webViewLink,size,owners(displayName)';
const toFile = (f: any): DriveFile => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink, size: f.size, owners: (f.owners ?? []).map((o: any) => o.displayName) });

/** Escapes a value for Drive's `q` language (single-quoted strings). */
export const driveQuote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export async function driveSearch(token: string, text: string | null, limit = 10): Promise<DriveFile[]> {
  const parts = ['trashed = false'];
  if (text?.trim()) parts.push(`(name contains ${driveQuote(text.trim())} or fullText contains ${driveQuote(text.trim())})`);
  const u = new URL(`${DRIVE}/files`);
  u.searchParams.set('q', parts.join(' and '));
  u.searchParams.set('pageSize', String(Math.min(limit, 25)));
  u.searchParams.set('orderBy', text?.trim() ? 'relevance' : 'modifiedTime desc');
  u.searchParams.set('fields', `files(${driveFields})`);
  u.searchParams.set('supportsAllDrives', 'true');
  u.searchParams.set('includeItemsFromAllDrives', 'true');
  if (text?.trim()) u.searchParams.delete('orderBy'); // relevance ordering is the default for fullText queries
  const j = await call(u.toString(), { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  return (j.files ?? []).map(toFile);
}

export async function driveMeta(token: string, id: string): Promise<DriveFile> {
  const j = await call(`${DRIVE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(driveFields)}&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  return toFile(j);
}

/** Google files are exported (Docs → text, Sheets → CSV, Slides → text); other files are downloaded. */
export async function driveContent(token: string, f: DriveFile): Promise<{ bytes: Uint8Array; name: string }> {
  const exportAs: Record<string, [string, string]> = { [GDOC]: ['text/plain', '.txt'], [GSHEET]: ['text/csv', '.csv'], [GSLIDES]: ['text/plain', '.txt'] };
  if (f.mimeType === FOLDER) throw new ProviderHttpError('That is a folder, not a file.', 400);
  if (f.mimeType.startsWith('application/vnd.google-apps.') && !exportAs[f.mimeType]) throw new ProviderHttpError('Qline can read Google Docs, Sheets and Slides, and normal files. This Google file type cannot be exported.', 400);
  if (f.size && Number(f.size) > DRIVE_READ_MAX_BYTES) throw new ProviderHttpError('The file is larger than 10 MB.', 413);
  const ex = exportAs[f.mimeType];
  const url = ex ? `${DRIVE}/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(ex[0])}` : `${DRIVE}/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (!r.ok) throw new ProviderHttpError(`Drive download failed (HTTP ${r.status})`, r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.byteLength > DRIVE_READ_MAX_BYTES) throw new ProviderHttpError('The file is larger than 10 MB.', 413);
  const name = ex && !f.name.toLowerCase().endsWith(ex[1]) ? `${f.name}${ex[1]}` : f.name;
  return { bytes: buf, name };
}

function multipart(meta: unknown, content: string, contentType: string) {
  const boundary = `qline${Math.random().toString(36).slice(2)}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${contentType}; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  return { body, type: `multipart/related; boundary=${boundary}` };
}

/** Creates a file Qline owns (drive.file). kind 'doc' becomes a Google Doc, 'sheet' a Google Sheet from CSV. */
export async function driveCreate(token: string, input: { name: string; content: string; kind: 'doc' | 'sheet' | 'text'; folderId?: string | null }): Promise<DriveFile> {
  const meta: any = { name: input.name, mimeType: input.kind === 'doc' ? GDOC : input.kind === 'sheet' ? GSHEET : 'text/plain' };
  if (input.folderId) meta.parents = [input.folderId];
  const m = multipart(meta, input.content, input.kind === 'sheet' ? 'text/csv' : 'text/plain');
  const j = await call(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${encodeURIComponent(driveFields)}&supportsAllDrives=true`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': m.type, accept: 'application/json' },
    body: m.body,
  });
  return toFile(j);
}

/** Replaces the content of a file. Google only allows this for files Qline created or was given (drive.file). */
export async function driveUpdate(token: string, id: string, content: string, mimeType: string): Promise<DriveFile> {
  const m = multipart({}, content, mimeType === GSHEET ? 'text/csv' : 'text/plain');
  const j = await call(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${encodeURIComponent(driveFields)}&supportsAllDrives=true`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': m.type, accept: 'application/json' },
    body: m.body,
  });
  return toFile(j);
}

// ---- Notion -------------------------------------------------------------------------------------
const NOTION = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2026-03-11';
const nh = (token: string) => ({ authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json', accept: 'application/json' });

export function notionTitle(page: any): string {
  for (const p of Object.values(page?.properties ?? {}) as any[]) {
    if (p?.type === 'title') return (p.title ?? []).map((t: any) => t.plain_text ?? '').join('') || 'Untitled';
  }
  return (page?.title ?? []).map((t: any) => t.plain_text ?? '').join('') || 'Untitled';
}

export async function notionSearch(token: string, text: string | null, limit = 10) {
  const j = await call(`${NOTION}/search`, {
    method: 'POST',
    headers: nh(token),
    body: JSON.stringify({ query: text ?? '', page_size: Math.min(limit, 25), filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' } }),
  });
  return (j.results ?? []).map((p: any) => ({ id: p.id, title: notionTitle(p), url: p.url, lastEdited: p.last_edited_time }));
}

const richText = (rt: any[]) => (rt ?? []).map((t: any) => t.plain_text ?? '').join('');

/** Turns Notion blocks into readable plain text (headings, lists, to-dos, quotes, code). */
export function blocksToText(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const v = b[b.type] ?? {};
    const t = richText(v.rich_text);
    switch (b.type) {
      case 'heading_1':
        lines.push(`# ${t}`);
        break;
      case 'heading_2':
        lines.push(`## ${t}`);
        break;
      case 'heading_3':
        lines.push(`### ${t}`);
        break;
      case 'bulleted_list_item':
        lines.push(`- ${t}`);
        break;
      case 'numbered_list_item':
        lines.push(`1. ${t}`);
        break;
      case 'to_do':
        lines.push(`[${v.checked ? 'x' : ' '}] ${t}`);
        break;
      case 'quote':
      case 'callout':
        lines.push(`> ${t}`);
        break;
      case 'code':
        lines.push('```', t, '```');
        break;
      case 'child_page':
        lines.push(`(page) ${v.title ?? ''}`);
        break;
      case 'divider':
        lines.push('---');
        break;
      default:
        if (t) lines.push(t);
    }
  }
  return lines.join('\n');
}

export async function notionRead(token: string, pageId: string, maxChars = 8000) {
  const page = await call(`${NOTION}/pages/${encodeURIComponent(pageId)}`, { headers: nh(token) });
  const blocks: any[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const u = new URL(`${NOTION}/blocks/${encodeURIComponent(pageId)}/children`);
    u.searchParams.set('page_size', '100');
    if (cursor) u.searchParams.set('start_cursor', cursor);
    const j = await call(u.toString(), { headers: nh(token) });
    blocks.push(...(j.results ?? []));
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  const text = blocksToText(blocks);
  return { id: page.id, title: notionTitle(page), url: page.url, lastEdited: page.last_edited_time, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

/** Plain text → paragraph / heading / bullet blocks (Notion caps rich text at 2,000 chars per item). */
export function textToBlocks(text: string): any[] {
  const out: any[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const rt = (s: string) => [{ type: 'text', text: { content: s.slice(0, 2000) } }];
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) out.push({ object: 'block', type: `heading_${h[1]!.length}`, [`heading_${h[1]!.length}`]: { rich_text: rt(h[2]!) } });
    else if (/^[-*]\s+/.test(line)) out.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(line.replace(/^[-*]\s+/, '')) } });
    else if (/^\[( |x)\]\s+/i.test(line)) out.push({ object: 'block', type: 'to_do', to_do: { rich_text: rt(line.replace(/^\[( |x)\]\s+/i, '')), checked: /^\[x\]/i.test(line) } });
    else out.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(line) } });
    if (out.length >= 100) break; // one request carries at most 100 blocks
  }
  return out;
}

export async function notionCreate(token: string, parentPageId: string, title: string, text: string) {
  const j = await call(`${NOTION}/pages`, {
    method: 'POST',
    headers: nh(token),
    body: JSON.stringify({ parent: { page_id: parentPageId }, properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 200) } }] } }, children: textToBlocks(text) }),
  });
  return { id: j.id, url: j.url, title };
}

export async function notionAppend(token: string, pageId: string, text: string) {
  const blocks = textToBlocks(text);
  if (!blocks.length) throw new ProviderHttpError('Nothing to add.', 400);
  await call(`${NOTION}/blocks/${encodeURIComponent(pageId)}/children`, { method: 'PATCH', headers: nh(token), body: JSON.stringify({ children: blocks }) });
  return { blocks: blocks.length };
}

// ---- GitHub -------------------------------------------------------------------------------------
const GH = 'https://api.github.com';
const gh = (token: string) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Qline' });
export const REPO = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/; // no "." or ".." segments

/** Repositories the person and the Qline GitHub App can both reach. */
export async function githubRepos(token: string, limit = 30) {
  const inst = await call(`${GH}/user/installations?per_page=20`, { headers: gh(token) });
  const repos: any[] = [];
  for (const i of inst.installations ?? []) {
    const r = await call(`${GH}/user/installations/${i.id}/repositories?per_page=${Math.min(limit, 100)}`, { headers: gh(token) });
    repos.push(...(r.repositories ?? []));
    if (repos.length >= limit) break;
  }
  return {
    installed: (inst.installations ?? []).length > 0,
    repos: repos.slice(0, limit).map((r) => ({ fullName: r.full_name, private: r.private, description: clip(r.description, 200), openIssues: r.open_issues_count, url: r.html_url, pushedAt: r.pushed_at })),
  };
}

export async function githubIssues(token: string, repo: string, opts: { state?: 'open' | 'closed' | 'all'; kind?: 'issues' | 'pulls' | 'both'; query?: string | null; limit?: number }) {
  const q = [`repo:${repo}`, opts.state && opts.state !== 'all' ? `state:${opts.state}` : '', opts.kind === 'issues' ? 'is:issue' : opts.kind === 'pulls' ? 'is:pr' : '', opts.query ?? ''].filter(Boolean).join(' ');
  const j = await call(`${GH}/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(opts.limit ?? 10, 30)}&sort=updated`, { headers: gh(token) });
  return (j.items ?? []).map((i: any) => ({ number: i.number, title: i.title, state: i.state, pr: !!i.pull_request, author: i.user?.login, labels: (i.labels ?? []).map((l: any) => l.name), comments: i.comments, updatedAt: i.updated_at, url: i.html_url }));
}

export async function githubRead(token: string, repo: string, number: number) {
  const i = await call(`${GH}/repos/${repo}/issues/${number}`, { headers: gh(token) });
  const comments = await call(`${GH}/repos/${repo}/issues/${number}/comments?per_page=20`, { headers: gh(token) });
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    pr: !!i.pull_request,
    author: i.user?.login,
    body: clip(i.body, 6000),
    url: i.html_url,
    comments: (comments ?? []).map((c: any) => ({ author: c.user?.login, at: c.created_at, body: clip(c.body, 1500) })),
  };
}

export async function githubIssueCreate(token: string, repo: string, title: string, body: string, labels?: string[]) {
  const j = await call(`${GH}/repos/${repo}/issues`, { method: 'POST', headers: { ...gh(token), 'content-type': 'application/json' }, body: JSON.stringify({ title, body, ...(labels?.length ? { labels } : {}) }) });
  return { number: j.number, url: j.html_url, title: j.title };
}

export async function githubComment(token: string, repo: string, number: number, body: string) {
  const j = await call(`${GH}/repos/${repo}/issues/${number}/comments`, { method: 'POST', headers: { ...gh(token), 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
  return { id: j.id, url: j.html_url };
}

// ---- Stripe -------------------------------------------------------------------------------------
const STRIPE = 'https://api.stripe.com/v1';
const sh = (key: string) => ({ authorization: `Bearer ${key}`, accept: 'application/json' });
/** Only restricted keys are accepted, so the owner decides exactly what Qline may touch. */
export const STRIPE_KEY = /^rk_(live|test)_[A-Za-z0-9]{10,}$/;

const money = (amount: number, currency: string) => ({ amount: amount / 100, currency: currency.toUpperCase() });

function form(obj: Record<string, string | number | boolean | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p.toString();
}

/** Checks the key can read something harmless; returns a display name for the account. */
export async function stripeVerify(key: string) {
  await call(`${STRIPE}/customers?limit=1`, { headers: sh(key) });
  try {
    const a = await call(`${STRIPE}/account`, { headers: sh(key) });
    return { name: a.settings?.dashboard?.display_name ?? a.business_profile?.name ?? 'Stripe account', email: a.email ?? null };
  } catch {
    return { name: 'Stripe account', email: null };
  }
}

export async function stripeSummary(key: string, days: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const charges = await call(`${STRIPE}/charges?limit=100&created[gte]=${since}`, { headers: sh(key) });
  const by: Record<string, { gross: number; refunded: number; count: number; failed: number }> = {};
  for (const c of charges.data ?? []) {
    const cur = String(c.currency).toUpperCase();
    by[cur] ??= { gross: 0, refunded: 0, count: 0, failed: 0 };
    if (c.status === 'succeeded' && c.paid) {
      by[cur]!.gross += c.amount / 100;
      by[cur]!.refunded += (c.amount_refunded ?? 0) / 100;
      by[cur]!.count += 1;
    } else if (c.status === 'failed') by[cur]!.failed += 1;
  }
  let open: { count: number; due: Record<string, number> } | null = null;
  try {
    const inv = await call(`${STRIPE}/invoices?status=open&limit=100`, { headers: sh(key) });
    open = { count: (inv.data ?? []).length, due: {} };
    for (const i of inv.data ?? []) open.due[String(i.currency).toUpperCase()] = (open.due[String(i.currency).toUpperCase()] ?? 0) + i.amount_remaining / 100;
  } catch {
    open = null; // the key may not include invoice read access
  }
  let balance: { available: any[]; pending: any[] } | null = null;
  try {
    const b = await call(`${STRIPE}/balance`, { headers: sh(key) });
    balance = { available: (b.available ?? []).map((x: any) => money(x.amount, x.currency)), pending: (b.pending ?? []).map((x: any) => money(x.amount, x.currency)) };
  } catch {
    balance = null;
  }
  return { days, sampled: (charges.data ?? []).length, more: !!charges.has_more, payments: by, openInvoices: open, balance };
}

export type StripeObject = 'customers' | 'charges' | 'invoices' | 'subscriptions' | 'products';

export async function stripeList(key: string, object: StripeObject, opts: { email?: string | null; status?: string | null; limit?: number }) {
  const u = new URL(`${STRIPE}/${object}`);
  u.searchParams.set('limit', String(Math.min(opts.limit ?? 10, 50)));
  if (opts.email && object === 'customers') u.searchParams.set('email', opts.email);
  if (opts.status && (object === 'invoices' || object === 'subscriptions')) u.searchParams.set('status', opts.status);
  const j = await call(u.toString(), { headers: sh(key) });
  const rows = (j.data ?? []).map((o: any) => {
    switch (object) {
      case 'customers':
        return { id: o.id, name: o.name, email: o.email, created: o.created };
      case 'charges':
        return { id: o.id, ...money(o.amount, o.currency), status: o.status, refunded: o.refunded, description: clip(o.description, 200), customer: o.customer, created: o.created };
      case 'invoices':
        return { id: o.id, number: o.number, status: o.status, ...money(o.amount_due, o.currency), remaining: o.amount_remaining / 100, customer: o.customer_email ?? o.customer, due: o.due_date, url: o.hosted_invoice_url };
      case 'subscriptions':
        return { id: o.id, status: o.status, customer: o.customer, currentPeriodEnd: o.current_period_end ?? o.items?.data?.[0]?.current_period_end, items: (o.items?.data ?? []).map((i: any) => i.price?.nickname ?? i.price?.id) };
      default:
        return { id: o.id, name: o.name, active: o.active, description: clip(o.description, 200) };
    }
  });
  return { rows, more: !!j.has_more };
}

export async function stripeCustomerCreate(key: string, input: { name: string; email?: string | null; description?: string | null }, idemKey: string) {
  const j = await call(`${STRIPE}/customers`, {
    method: 'POST',
    headers: { ...sh(key), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idemKey },
    body: form({ name: input.name, email: input.email, description: input.description }),
  });
  return { id: j.id, name: j.name, email: j.email };
}

/**
 * Creates a DRAFT invoice with line items. It is never finalized, sent or charged by Qline:
 * auto_advance=false and collection_method=send_invoice, so a person reviews and sends it in Stripe.
 */
export async function stripeInvoiceDraft(key: string, input: { customer: string; currency: string; items: { description: string; amount: number }[]; daysUntilDue: number; memo?: string | null }, idemKey: string) {
  const inv = await call(`${STRIPE}/invoices`, {
    method: 'POST',
    headers: { ...sh(key), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `${idemKey}:invoice` },
    body: form({ customer: input.customer, currency: input.currency.toLowerCase(), collection_method: 'send_invoice', days_until_due: input.daysUntilDue, auto_advance: false, description: input.memo }),
  });
  for (const [i, it] of input.items.entries()) {
    await call(`${STRIPE}/invoiceitems`, {
      method: 'POST',
      headers: { ...sh(key), 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': `${idemKey}:item:${i}` },
      body: form({ customer: input.customer, invoice: inv.id, currency: input.currency.toLowerCase(), amount: Math.round(it.amount * 100), description: it.description }),
    });
  }
  return { id: inv.id, status: inv.status, url: `https://dashboard.stripe.com/invoices/${inv.id}` };
}
