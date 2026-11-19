import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { need, tx, type Env } from '../core/context';
import { ApiError, badRequest, notFound } from '../core/errors';
import { readLimitedForm } from '../core/upload';
import { detectFormat, getObject, MAX_FILE_BYTES, parseFile, putObject, type Parsed } from './imports';

/**
 * v1.6: files sent to the AI in chat (docs/16 §Files).
 * Documents and spreadsheets are parsed once and kept, bounded, in files.extracted so agents can read them
 * with files.read. Images are kept as-is and shown to vision-capable models with the message they came with.
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // provider limit for inline images
export const EXTRACT_TEXT_MAX = 100_000;
export const EXTRACT_ROWS_MAX = 500;
export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Image type from magic bytes, never from the name or the client's content-type. */
export function detectImage(b: Uint8Array): ImageMime | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

export interface Extracted {
  kind: 'image' | 'records' | 'document';
  columns?: string[];
  rowCount?: number;
  rows?: Record<string, string>[];
  text?: string;
  chars?: number;
  truncated?: boolean;
  note?: string | null;
}

export function extractFrom(p: Parsed): Extracted {
  if (p.kind === 'records') return { kind: 'records', columns: p.columns, rowCount: p.rows.length, rows: p.rows.slice(0, EXTRACT_ROWS_MAX), truncated: p.rows.length > EXTRACT_ROWS_MAX, note: p.note ?? null };
  const text = p.text ?? '';
  return { kind: 'document', text: text.slice(0, EXTRACT_TEXT_MAX), chars: text.length, truncated: text.length > EXTRACT_TEXT_MAX, note: p.note ?? null };
}

export function describe(e: Extracted): string {
  if (e.kind === 'image') return 'Image';
  if (e.kind === 'records') return `${e.rowCount} rows · ${(e.columns ?? []).slice(0, 6).join(', ')}${(e.columns?.length ?? 0) > 6 ? '…' : ''}`;
  return `${(e.chars ?? 0).toLocaleString('en-US')} characters of text`;
}

/** What the model sees for an attachment: metadata plus a bounded preview, always as untrusted data. */
export function attachmentContext(f: { id: string; name: string; extracted: Extracted }) {
  const e = f.extracted;
  const base = { fileId: f.id, name: f.name, kind: e.kind };
  if (e.kind === 'image') return { ...base, note: 'Image attached. Use image.show to display it again.' };
  if (e.kind === 'records') return { ...base, columns: e.columns, rowCount: e.rowCount, firstRows: (e.rows ?? []).slice(0, 15), more: 'Use files.read for more rows.' };
  return { ...base, chars: e.chars, text: (e.text ?? '').slice(0, 6000), more: (e.chars ?? 0) > 6000 ? 'Use files.read with offset for the rest.' : undefined };
}

export const fileRoutes = new Hono<Env>();

fileRoutes.post('/agents/attachments', async (c) => {
  const t = need(c, 'agents.use');
  const form = await readLimitedForm(c.req.raw, MAX_FILE_BYTES + 64 * 1024, 'The limit is 10 MB per file (5 MB for images).');
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw badRequest('Send the file as multipart field "file".');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw badRequest('The file is empty.');
  const safeName = file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'upload';
  let mime: string;
  let extracted: Extracted;
  const img = detectImage(bytes);
  if (img || IMAGE_EXT.test(safeName)) {
    if (!img) throw badRequest('The file content does not match its extension.');
    if (bytes.length > IMAGE_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'Image too large', 'The limit is 5 MB per image.');
    mime = img;
    extracted = { kind: 'image' };
  } else {
    if (bytes.length > MAX_FILE_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'File too large', 'The limit is 10 MB per file.');
    const format = detectFormat(safeName, bytes);
    extracted = extractFrom(await parseFile(format, bytes));
    mime = file.type && !file.type.startsWith('image/') ? file.type : 'application/octet-stream';
  }
  const id = randomUUID();
  const key = `org/${t.orgId}/ws/${t.workspaceId}/chat/${id}`;
  await putObject(key, bytes, mime);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const row = await tx(t, async (q) => {
    const f = await q.one(
      `insert into files (id, org_id, workspace_id, name, mime, size_bytes, sha256, storage_key, created_by, source, extracted)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'chat',$10) returning id, name, mime, size_bytes, created_at`,
      [id, t.orgId, t.workspaceId, safeName, mime, bytes.length, sha, key, t.userId, JSON.stringify(extracted)],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'file.attached', targetRef: `file:${id}`, detail: { name: safeName, kind: extracted.kind, size: bytes.length } });
    return f;
  });
  return c.json({ ...row, kind: extracted.kind, summary: describe(extracted), note: extracted.note ?? null }, 201);
});

/** Image bytes for display in chat. Only images are served, with a fixed type and nosniff. */
fileRoutes.get('/files/:id/content', async (c) => {
  const t = need(c, 'documents.read');
  const f = await tx(t, (q) => q.one('select storage_key, mime from files where id=$1', [c.req.param('id')]));
  if (!f) throw notFound('File');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(f.mime)) throw new ApiError(415, 'NOT_AN_IMAGE', 'Only images can be shown');
  const bytes = await getObject(f.storage_key);
  if (detectImage(bytes) !== f.mime) throw new ApiError(415, 'NOT_AN_IMAGE', 'Only images can be shown');
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(body, { headers: { 'content-type': f.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600', 'content-disposition': 'inline' } });
});

/** Loads chat attachments the caller can see (RLS) — used when posting a message and by the runner. */
export async function loadAttachments(q: Q, ids: string[]) {
  if (!ids.length) return [];
  return q.many(`select id, name, mime, size_bytes, storage_key, extracted from files where id = any($1::uuid[])`, [ids]) as Promise<
    { id: string; name: string; mime: string; size_bytes: number; storage_key: string; extracted: Extracted }[]
  >;
}
