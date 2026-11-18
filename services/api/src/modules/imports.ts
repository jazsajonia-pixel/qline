import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import Papa from 'papaparse';
import { z } from 'zod';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { need, requireTenant, requireUser, tx, type Env } from '../core/context';
import { env } from '../core/env';
import { ApiError, badRequest, notFound } from '../core/errors';
import { dispatch } from '../core/events';
import { body } from '../core/validate';
import { contactInput, createContact, createTask } from './work';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // Function request budget; docs/08 allows 25 MB with resumable upload (planned)
export const MAX_ROWS = 20_000;

// ---------------------------------------------------------------------------
// Storage (Neon Object Storage, S3-compatible; credentials injected by Neon)
// ---------------------------------------------------------------------------
let s3: S3Client | null = null;
export function storageConfigured() {
  return !!(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}
function client() {
  if (!storageConfigured()) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'File storage is not configured');
  if (!s3) s3 = new S3Client({ endpoint: process.env.AWS_ENDPOINT_URL_S3, region: process.env.AWS_REGION ?? 'ap-southeast-1', forcePathStyle: true });
  return s3;
}
// Tests only: an in-memory store when no bucket is configured. Never used outside NODE_ENV=test.
const memStore = new Map<string, Uint8Array>();
const useMem = () => process.env.NODE_ENV === 'test' && !storageConfigured();
export async function putObject(key: string, bytes: Uint8Array, mime: string) {
  if (useMem()) return void memStore.set(key, bytes);
  await client().send(new PutObjectCommand({ Bucket: env.bucket, Key: key, Body: bytes, ContentType: mime }));
}
export async function getObject(key: string): Promise<Uint8Array> {
  if (useMem()) {
    const b = memStore.get(key);
    if (!b) throw notFound('File');
    return b;
  }
  const r = await client().send(new GetObjectCommand({ Bucket: env.bucket, Key: key }));
  return new Uint8Array(await r.Body!.transformToByteArray());
}
export async function storageReady(): Promise<boolean> {
  if (!storageConfigured()) return false;
  try {
    await client().send(new HeadBucketCommand({ Bucket: env.bucket }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Validation + parsing (docs/08 §2)
// ---------------------------------------------------------------------------
export type Format = 'csv' | 'xlsx' | 'json' | 'txt' | 'md' | 'pdf' | 'docx';
const EXT: Record<string, Format> = { csv: 'csv', xlsx: 'xlsx', json: 'json', txt: 'txt', md: 'md', markdown: 'md', pdf: 'pdf', docx: 'docx' };
export const RECORD_FORMATS: Format[] = ['csv', 'xlsx', 'json'];

export function detectFormat(name: string, bytes: Uint8Array): Format {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xlsm' || ext === 'xls' || ext === 'docm') throw badRequest('Macro-enabled and legacy Office files are not accepted. Save as .xlsx or .docx.');
  const f = EXT[ext];
  if (!f) throw badRequest('Unsupported file type. Use CSV, XLSX, JSON, TXT, MD, PDF or DOCX.');
  const head = Array.from(bytes.slice(0, 5));
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  if ((f === 'xlsx' || f === 'docx') && !isZip) throw badRequest('The file content does not match its extension.');
  if (f === 'pdf' && !isPdf) throw badRequest('The file content does not match its extension.');
  if (['csv', 'json', 'txt', 'md'].includes(f) && (isZip || isPdf || bytes.slice(0, 4096).includes(0))) throw badRequest('This does not look like a text file.');
  return f;
}

export interface Parsed {
  kind: 'records' | 'document';
  columns: string[];
  rows: Record<string, string>[];
  text?: string;
  note?: string;
}

function cellToString(v: any): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    // Formulas are never evaluated: use the cached result if the file has one, else leave empty.
    if ('result' in v) return v.result == null ? '' : cellToString(v.result);
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.text ?? v.hyperlink);
    return '';
  }
  return String(v).trim();
}

export async function parseFile(format: Format, bytes: Uint8Array): Promise<Parsed> {
  const text = () => new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '');
  if (format === 'csv') {
    const r = Papa.parse<Record<string, string>>(text(), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
    const columns = (r.meta.fields ?? []).filter(Boolean);
    if (!columns.length) throw badRequest('No header row found in the CSV.');
    return { kind: 'records', columns, rows: r.data.slice(0, MAX_ROWS) };
  }
  if (format === 'json') {
    let data: unknown;
    try {
      data = JSON.parse(text());
    } catch {
      throw badRequest('The JSON file is not valid.');
    }
    const arr = Array.isArray(data) ? data : Array.isArray((data as any)?.items) ? (data as any).items : null;
    if (!arr) throw badRequest('JSON must be an array of objects (or {"items": [...]})');
    const rows = arr.slice(0, MAX_ROWS).filter((x: unknown) => x && typeof x === 'object' && !Array.isArray(x)).map((o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')])));
    const columns = Array.from(new Set(rows.flatMap((r: any) => Object.keys(r)))).slice(0, 100) as string[];
    return { kind: 'records', columns, rows };
  }
  if (format === 'xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as any);
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest('The workbook has no sheets.');
    const header: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      header[col - 1] = cellToString(cell.value);
    });
    const columns = header.map((h, i) => h || `Column ${i + 1}`);
    const rows: Record<string, string>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1 || rows.length >= MAX_ROWS) return;
      const o: Record<string, string> = {};
      columns.forEach((c, i) => (o[c] = cellToString(row.getCell(i + 1).value)));
      if (Object.values(o).some((v) => v)) rows.push(o);
    });
    return { kind: 'records', columns, rows, note: wb.worksheets.length > 1 ? `Only the first sheet ("${ws.name}") was read.` : undefined };
  }
  if (format === 'txt' || format === 'md') return { kind: 'document', columns: [], rows: [], text: text().slice(0, 500_000) };
  if (format === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes);
    const { text: t } = await extractText(pdf, { mergePages: true });
    const s = (Array.isArray(t) ? t.join('\n') : t).trim();
    return { kind: 'document', columns: [], rows: [], text: s.slice(0, 500_000), note: s ? undefined : 'No text layer found. Scanned PDFs need OCR, which is planned.' };
  }
  const mammoth = await import('mammoth');
  const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return { kind: 'document', columns: [], rows: [], text: r.value.slice(0, 500_000) };
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------
export const TARGETS = {
  contacts: ['name', 'email', 'phone', 'title', 'stage', 'notes', 'company'],
  companies: ['name', 'domain', 'notes'],
  tasks: ['title', 'description', 'status', 'priority', 'dueAt'],
} as const;
export type Target = keyof typeof TARGETS;

const SYNONYMS: Record<string, string[]> = {
  name: ['name', 'full name', 'contact', 'contact name', 'client', 'client name', 'customer', 'company name'],
  email: ['email', 'e-mail', 'email address', 'mail'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'phone number', 'cell'],
  title: ['title', 'job title', 'position', 'role', 'task', 'task name', 'subject'],
  stage: ['stage', 'status', 'pipeline', 'lead status'],
  notes: ['notes', 'note', 'comments', 'remarks'],
  company: ['company', 'organization', 'organisation', 'business', 'account'],
  domain: ['domain', 'website', 'url', 'site'],
  description: ['description', 'details', 'body'],
  status: ['status', 'state', 'stage'],
  priority: ['priority', 'importance'],
  dueAt: ['due', 'due date', 'deadline', 'due at', 'due_date'],
};

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Best column for each field of one target (by header synonyms). */
export function fieldsFor(columns: string[], target: Target): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const f of TARGETS[target]) {
    const col = columns.find((c) => SYNONYMS[f]?.includes(norm(c))) ?? columns.find((c) => SYNONYMS[f]?.some((s) => norm(c).includes(s)));
    if (col && !Object.values(fields).includes(col)) fields[f] = col;
  }
  return fields;
}

export function suggestMapping(columns: string[]): { target: Target; fields: Record<string, string> } {
  const score = (target: Target) => fieldsFor(columns, target);
  const c = score('contacts');
  const t = score('tasks');
  const co = score('companies');
  if (t.dueAt || (t.title && !c.email && (t.status || t.priority))) return { target: 'tasks', fields: t };
  if (c.email || c.phone) return { target: 'contacts', fields: c };
  if (co.domain) return { target: 'companies', fields: co };
  return { target: 'contacts', fields: c };
}

function parseDate(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}


/** Writes parsed rows (or a document) for an import job. Shared by the Imports screen and the AI's files.import_records (v1.6). */
export async function importParsed(
  q: Q,
  t: { orgId: string; workspaceId: string; userId: string },
  actor: { kind: 'user' | 'agent'; id: string },
  job: { id: string; file_id: string; file_name: string; mapping: unknown },
  parsed: Parsed,
): Promise<{ ok: number; skipped: number; errors: { row: number; message: string }[] }> {
  const src = { kind: 'import', ref: `import:${job.id}`, importJobId: job.id };
  let ok = 0;
  let skipped = 0;
  const errors: { row: number; message: string }[] = [];
  if (parsed.kind === 'document') {
    const title = job.file_name.replace(/\.[^.]+$/, '');
    await q.exec(
      `insert into documents (org_id, workspace_id, file_id, kind, title, body, folder, source_kind, source_ref, import_job_id, created_by) values ($1,$2,$3,'document',$4,$5,'Imported','import',$6,$7,$8)`,
      [t.orgId, t.workspaceId, job.file_id, title, parsed.text ?? '', `import:${job.id}`, job.id, `user:${t.userId}`],
    );
    ok = 1;
  } else {
    const m = job.mapping as { target: Target; fields: Record<string, string>; duplicates: 'skip' | 'create' };
    const get = (row: Record<string, string>, f: string) => (m.fields[f] ? (row[m.fields[f]] ?? '').toString().trim() : '');
    const seen = new Set<string>();
    const existingEmails = new Set<string>(
      m.target === 'contacts' ? (await q.many(`select lower(email) as e from contacts where deleted_at is null and email is not null`)).map((r) => r.e) : [],
    );
    const existingCompanies = new Map<string, string>((await q.many(`select id, lower(name) as n from companies where deleted_at is null`)).map((r) => [r.n, r.id]));
    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      try {
        if (m.target === 'contacts') {
          const email = get(row, 'email').toLowerCase() || null;
          if (email && m.duplicates === 'skip' && (existingEmails.has(email) || seen.has(email))) {
            skipped++;
            continue;
          }
          let companyId: string | null = null;
          const companyName = get(row, 'company');
          if (companyName) {
            companyId = existingCompanies.get(companyName.toLowerCase()) ?? null;
            if (!companyId) {
              const co = await q.one(`insert into companies (org_id, workspace_id, name, source_kind, source_ref, import_job_id, created_by) values ($1,$2,$3,'import',$4,$5,$6) returning id`, [
                t.orgId,
                t.workspaceId,
                companyName,
                `import:${job.id}`,
                job.id,
                `user:${t.userId}`,
              ]);
              companyId = co.id;
              existingCompanies.set(companyName.toLowerCase(), co.id);
            }
          }
          const input = contactInput.safeParse({
            name: get(row, 'name'),
            email: email || undefined,
            phone: get(row, 'phone') || undefined,
            title: get(row, 'title') || undefined,
            stage: get(row, 'stage') || undefined,
            notes: get(row, 'notes') || undefined,
            companyId,
          });
          if (!input.success) throw new Error(input.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
          await createContact(q, t, actor, input.data, src);
          if (email) seen.add(email);
        } else if (m.target === 'companies') {
          const name = get(row, 'name');
          if (!name) throw new Error('name is empty');
          if (m.duplicates === 'skip' && existingCompanies.has(name.toLowerCase())) {
            skipped++;
            continue;
          }
          const co = await q.one(`insert into companies (org_id, workspace_id, name, domain, notes, source_kind, source_ref, import_job_id, created_by) values ($1,$2,$3,$4,$5,'import',$6,$7,$8) returning id`, [
            t.orgId,
            t.workspaceId,
            name,
            get(row, 'domain') || null,
            get(row, 'notes') || null,
            `import:${job.id}`,
            job.id,
            `user:${t.userId}`,
          ]);
          existingCompanies.set(name.toLowerCase(), co.id);
        } else {
          const title = get(row, 'title');
          if (!title) throw new Error('title is empty');
          const pr = get(row, 'priority').toLowerCase();
          await createTask(
            q,
            t,
            actor,
            {
              title: title.slice(0, 300),
              description: get(row, 'description') || null,
              status: get(row, 'status') ? get(row, 'status').toLowerCase().replace(/\s+/g, '_') : undefined,
              priority: (['low', 'normal', 'high', 'urgent'].includes(pr) ? pr : undefined) as any,
              dueAt: parseDate(get(row, 'dueAt')),
            },
            src,
          );
        }
        ok++;
      } catch (e) {
        if (errors.length < 500) errors.push({ row: i + 2, message: (e as Error).message.slice(0, 200) });
      }
    }
    if (!ok && errors.length) {
      // nothing imported: still a completed job with a clear report
    }
    await audit(q, { orgId: t.orgId, actorKind: actor.kind, actorId: actor.id, action: 'import.completed', targetRef: `import:${job.id}`, detail: { ok, skipped, failed: errors.length, target: m.target } });
    return { ok, skipped, errors };
  }
  await audit(q, { orgId: t.orgId, actorKind: actor.kind, actorId: actor.id, action: 'import.completed', targetRef: `import:${job.id}`, detail: { ok, target: 'documents' } });
  return { ok, skipped, errors };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const importRoutes = new Hono<Env>();

importRoutes.post('/files', async (c) => {
  const t = need(c, 'imports.run');
  const len = Number(c.req.header('content-length') ?? '0');
  if (len > MAX_FILE_BYTES + 64 * 1024) throw new ApiError(413, 'FILE_TOO_LARGE', 'File too large', 'The limit is 10 MB per file.');
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw badRequest('Send the file as multipart field "file".');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) throw badRequest('The file is empty.');
  if (bytes.length > MAX_FILE_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'File too large', 'The limit is 10 MB per file.');
  const safeName = file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'upload';
  const format = detectFormat(safeName, bytes);
  const parsed = await parseFile(format, bytes);
  const id = randomUUID();
  const key = `org/${t.orgId}/ws/${t.workspaceId}/${id}`;
  await putObject(key, bytes, file.type || 'application/octet-stream');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const suggestion = parsed.kind === 'records' ? suggestMapping(parsed.columns) : null;
  const out = await tx(t, async (q) => {
    const f = await q.one(`insert into files (id, org_id, workspace_id, name, mime, size_bytes, sha256, storage_key, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, name, size_bytes, created_at`, [
      id,
      t.orgId,
      t.workspaceId,
      safeName,
      file.type || 'application/octet-stream',
      bytes.length,
      sha,
      key,
      t.userId,
    ]);
    const job = await q.one(
      `insert into import_jobs (org_id, workspace_id, file_id, format, detected_entity, target_entity, columns, preview, mapping, rows_total, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [
        t.orgId,
        t.workspaceId,
        id,
        format,
        parsed.kind === 'document' ? 'document' : suggestion!.target,
        parsed.kind === 'document' ? 'documents' : suggestion!.target,
        JSON.stringify(parsed.columns),
        JSON.stringify(parsed.kind === 'document' ? [{ text: (parsed.text ?? '').slice(0, 1200) }] : parsed.rows.slice(0, 10)),
        JSON.stringify(parsed.kind === 'document' ? { target: 'documents' } : { target: suggestion!.target, fields: suggestion!.fields, duplicates: 'skip' }),
        parsed.kind === 'document' ? 1 : parsed.rows.length,
        t.userId,
      ],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'file.uploaded', targetRef: `file:${id}`, detail: { name: safeName, format, size: bytes.length } });
    return { file: f, import: job };
  });
  return c.json({ ...out, note: parsed.note ?? null }, 201);
});

importRoutes.get('/imports', async (c) => {
  const t = c.get('tenant');
  const items = await tx(t, (q) => q.many(`select j.*, f.name as file_name from import_jobs j join files f on f.id=j.file_id order by j.created_at desc limit 50`));
  return c.json({ items });
});

importRoutes.get('/imports/:id', async (c) => {
  const t = c.get('tenant');
  const j = await tx(t, (q) => q.one(`select j.*, f.name as file_name from import_jobs j join files f on f.id=j.file_id where j.id=$1`, [c.req.param('id')]));
  if (!j) throw notFound('Import');
  return c.json({ ...j, targets: TARGETS });
});

importRoutes.put('/imports/:id/mapping', async (c) => {
  const t = need(c, 'imports.run');
  const input = await body(c, z.object({ target: z.enum(['contacts', 'companies', 'tasks']), fields: z.record(z.string(), z.string()), duplicates: z.enum(['skip', 'create']).default('skip') }));
  const j = await tx(t, async (q) => {
    const cur = await q.one('select * from import_jobs where id=$1', [c.req.param('id')]);
    if (!cur) throw notFound('Import');
    if (!['parsed', 'mapped'].includes(cur.status)) throw new ApiError(409, 'IMPORT_LOCKED', 'Import already ran');
    const allowed = new Set<string>(TARGETS[input.target]);
    for (const [f, col] of Object.entries(input.fields)) {
      if (!allowed.has(f)) throw badRequest(`Unknown field ${f} for ${input.target}.`);
      if (!cur.columns.includes(col)) throw badRequest(`Column "${col}" is not in the file.`);
    }
    const required = input.target === 'tasks' ? 'title' : 'name';
    if (!input.fields[required]) throw badRequest(`Map a column to "${required}".`);
    return q.one(`update import_jobs set mapping=$2, target_entity=$3, status='mapped' where id=$1 returning *`, [cur.id, JSON.stringify(input), input.target]);
  });
  return c.json(j);
});

importRoutes.post('/imports/:id/run', async (c) => {
  const t = need(c, 'imports.run');
  const job = await tx(t, async (q) => {
    const j = await q.one(`select j.*, f.storage_key, f.name as file_name from import_jobs j join files f on f.id=j.file_id where j.id=$1 for update of j`, [c.req.param('id')]);
    if (!j) throw notFound('Import');
    if (!['parsed', 'mapped'].includes(j.status)) throw new ApiError(409, 'IMPORT_ALREADY_RUN', 'Import already ran', `Status is ${j.status}.`);
    await q.exec(`update import_jobs set status='running' where id=$1`, [j.id]);
    return j;
  });
  try {
    const bytes = await getObject(job.storage_key);
    const parsed = await parseFile(job.format, bytes);
    const actor = { kind: 'user' as const, id: t.userId };
    const result = await tx(t, (q) => importParsed(q, t, actor, job, parsed));
    const done = await tx(t, (q) =>
      q.one(`update import_jobs set status='completed', rows_ok=$2, rows_skipped=$3, rows_failed=$4, errors=$5, completed_at=now() where id=$1 returning *`, [
        job.id,
        result.ok,
        result.skipped,
        result.errors.length,
        JSON.stringify(result.errors),
      ]),
    );
    await dispatch(t, [{ type: 'import.completed', id: `import:${job.id}`, data: { importId: job.id, target: done.target_entity, ok: result.ok } }]);
    return c.json(done);
  } catch (e) {
    await tx(t, (q) => q.exec(`update import_jobs set status='failed', errors=$2 where id=$1`, [job.id, JSON.stringify([{ row: 0, message: (e as Error).message.slice(0, 300) }])]));
    throw e;
  }
});

importRoutes.post('/imports/:id/rollback', async (c) => {
  const t = need(c, 'imports.run');
  const out = await tx(t, async (q) => {
    const j = await q.one('select * from import_jobs where id=$1 for update', [c.req.param('id')]);
    if (!j) throw notFound('Import');
    if (j.status !== 'completed') throw new ApiError(409, 'IMPORT_NOT_COMPLETED', 'Nothing to roll back');
    const counts: Record<string, number> = {};
    for (const table of ['contacts', 'companies', 'tasks', 'documents']) {
      counts[table] = await q.exec(`update ${table} set deleted_at=now() where import_job_id=$1 and deleted_at is null`, [j.id]);
    }
    await q.exec(`update import_jobs set status='rolled_back' where id=$1`, [j.id]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'import.rolled_back', targetRef: `import:${j.id}`, detail: counts });
    return counts;
  });
  return c.json({ ok: true, removed: out });
});
