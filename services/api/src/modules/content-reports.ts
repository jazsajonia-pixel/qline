import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env, type TenantCtx } from '../core/context';
import type { Q } from '../core/db';
import { ApiError, conflict, notFound } from '../core/errors';
import { driveChildren, driveDownload, driveMeta, DRIVE_FOLDER, DRIVE_SHORTCUT, ProviderHttpError, type DriveFile } from '../integrations/connectors';
import { actorKind, driveFailure, mappedDrive } from './content';
import { download, FILE_ID, integrity, JOB_COLS, jobOrThrow, jobOut, RESULT_SCHEMA, sha256 } from './content-jobs';

/**
 * Content handoff, Slice 2b (docs/22 ADR-C2, C3, C7). Reads what an external editor reports and decides, with Qline's
 * own Drive checks, what actually happened.
 *
 * Trust rules:
 * - A report is untrusted data: size-capped, strictly parsed, cleaned of control characters, stored as plain text and
 *   never given to a model. It only sets `external_status`. A "completed" claim moves the job to validating_output;
 *   only Qline's own files.get checks can make it output_verified.
 * - jobId + nonce correlate a report with a job. They do not prove who wrote it.
 * - State follows the strongest valid report for the current revision (status rank, then sequence, then time), never
 *   arrival order, so late or replayed reports cannot move a job backwards.
 * - Read-only Drive: files.list, files.get and alt=media downloads. The acknowledgement is stored in the DB only; no
 *   Drive copy is written in this slice (ADR-C3 capability check not run, no Drive writes allowed).
 */
export const contentReportRoutes = new Hono<Env>();

export const REPORT_MAX_BYTES = 256 * 1024;
export const OUTPUT_MAX_BYTES = 20 * 1024 ** 3;
export const VALIDATION_VERSION = 1;
export const ACK_SCHEMA = 'qline.content.ack/1';
const REPORTS_PER_CHECK = 50;
const TAMPER_JOBS_PER_CHECK = 50;
const LIST_PAGES = 10;
const STATUSES = ['accepted', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled'] as const;
type Status = (typeof STATUSES)[number];
const RANK: Record<Status, number> = { accepted: 1, in_progress: 2, completed: 3, failed: 3, blocked: 3, cancelled: 3 };
export const REPORT_NAME = /^(QLINE-\d{8}-[0-9a-hjkmnp-tv-z]{6})-r(\d{1,6})\.result\.json$/;
/** States in which reports are only recorded: work is closed, being checked, or already handed to a person. */
const FROZEN = ['cancelled', 'expired', 'validating_output', 'output_verified', 'awaiting_video_qa'];

export type Finding = { code: string; message: string; fileId?: string };

/** Removes control and bidi-override characters (Postgres also rejects NUL); keeps newlines and tabs. */
export const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').normalize('NFC');
const cleanText = (max: number) => z.string().max(max).transform(clean);

const OUTPUT = z
  .object({
    driveFileId: FILE_ID,
    name: cleanText(255).pipe(z.string().min(1)),
    md5: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    sizeBytes: z.number().int().min(0).max(OUTPUT_MAX_BYTES).optional(),
  })
  .strict();
export const RESULT = z
  .object({
    schema: z.literal(RESULT_SCHEMA),
    jobId: z.string().max(40),
    revision: z.number().int().min(1).max(1_000_000),
    nonce: z.string().max(64),
    status: z.enum(STATUSES),
    sequence: z.number().int().min(0).max(1_000_000_000).optional(),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    outputs: z.array(OUTPUT).max(10).default([]),
    message: cleanText(2000).optional(),
  })
  .strict();
export type Report = z.infer<typeof RESULT>;

/** Bytes → a valid report, or findings explaining why not. Nothing from the file is trusted before this. */
export function parseReport(bytes: Uint8Array): { report: Report; findings?: undefined } | { report?: undefined; findings: Finding[] } {
  if (bytes.byteLength > REPORT_MAX_BYTES) return { findings: [{ code: 'too_large', message: `The report is larger than ${REPORT_MAX_BYTES / 1024} KB.` }] };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { findings: [{ code: 'not_utf8', message: 'The report is not UTF-8 text.' }] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { findings: [{ code: 'invalid_json', message: 'The report is not valid JSON.' }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { findings: [{ code: 'invalid_shape', message: 'The report must be a JSON object.' }] };
  if ((raw as any).schema !== RESULT_SCHEMA) return { findings: [{ code: 'unsupported_schema', message: `Unsupported report format. Expected schema "${RESULT_SCHEMA}".` }] };
  const r = RESULT.safeParse(raw);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => clean(i.path.join('.') || (i.code === 'unrecognized_keys' ? 'unknown field' : 'report')).slice(0, 60)))].slice(0, 10);
    return { findings: [{ code: 'invalid_fields', message: `Invalid or unknown fields: ${fields.join(', ')}.` }] };
  }
  return { report: r.data };
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Does this valid report belong to the job's current revision? */
function correlate(job: any, r: Report): Finding[] {
  if (r.jobId !== job.job_code) return [{ code: 'job_mismatch', message: 'The report is for a different job.' }];
  if (r.revision < job.revision) return [{ code: 'stale_revision', message: `The report is for revision ${r.revision}; the job is now at revision ${job.revision}.` }];
  if (r.revision > job.revision) return [{ code: 'unknown_revision', message: `The report is for revision ${r.revision}, which was never issued.` }];
  if (!sameSecret(r.nonce, job.nonce)) return [{ code: 'nonce_mismatch', message: 'The security code (nonce) does not match this revision.' }];
  if (job.qline_state === 'cancelled' || job.qline_state === 'expired') return [{ code: 'job_closed', message: `The job is ${job.qline_state}.` }];
  if (new Date(job.expires_at).getTime() < Date.now()) return [{ code: 'job_expired', message: 'The job expired before this report arrived.' }];
  return [];
}

type Channel = { channel: 'manual' } | { channel: 'drive'; reportFileId: string; reportVersion: string };
type IngestResult = { outcome: 'applied' | 'duplicate' | 'rejected' | 'recorded'; findings: Finding[]; verification?: 'verified' | 'rejected' | 'deferred' | 'stale' };

export const insertEvent = (q: Q, t: TenantCtx, job: any, e: { source: string; key: string; revision: number; sequence?: number | null; type: string; message?: string | null; fileIds?: string[]; detail?: object; rawSha?: string | null; occurredAt?: Date }) =>
  q.one<{ id: string }>(
    `insert into content_job_events (org_id, job_id, source, event_key, revision, sequence, event_type, message, file_ids, detail, raw_sha256, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12, now())) on conflict (job_id, source, event_key) do nothing returning id`,
    [t.orgId, job.id, e.source, e.key, e.revision, e.sequence ?? null, e.type, e.message ?? null, e.fileIds ?? [], JSON.stringify(e.detail ?? {}), e.rawSha ?? null, e.occurredAt ?? null],
  );

async function nextAck(q: Q, t: TenantCtx, job: any, a: { status: 'accepted' | 'rejected'; findings: Finding[]; verifiedOutputIds?: string[]; reportSha: string | null; revision?: number }) {
  const version = ((await q.one<{ v: number }>('select coalesce(max(version), 0)::int as v from content_job_acks where job_id=$1', [job.id]))?.v ?? 0) + 1;
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  const row = { revision: a.revision ?? job.revision, version, status: a.status, findings: a.findings, verified_output_ids: a.verifiedOutputIds ?? [], validation_version: VALIDATION_VERSION, report_sha256: a.reportSha, created_at: createdAt };
  const sha = sha256(ackJson(job.job_code, row));
  await q.exec(
    `insert into content_job_acks (org_id, job_id, revision, version, status, findings, verified_output_ids, validation_version, correlation_id, report_sha256, sha256, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [t.orgId, job.id, row.revision, version, a.status, JSON.stringify(a.findings), row.verified_output_ids, VALIDATION_VERSION, t.correlationId, a.reportSha, sha, createdAt],
  );
  return version;
}

/** The acknowledgement as a file. Built from the stored row in a fixed order, so its SHA-256 can be re-checked. */
export function ackJson(jobCode: string, r: any): string {
  return (
    JSON.stringify(
      {
        schema: ACK_SCHEMA,
        jobId: jobCode,
        revision: r.revision,
        version: r.version,
        status: r.status,
        findings: r.findings,
        verifiedOutputIds: r.verified_output_ids,
        validationVersion: r.validation_version,
        reportSha256: r.report_sha256 ?? null,
        createdAt: new Date(r.created_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
      null,
      2,
    ) + '\n'
  );
}

/** One notification per person per job event; repeats collapse on the dedupe key. Text is Qline's own, never the report's. */
export async function notifyJob(q: Q, t: TenantCtx, job: any, key: string, title: string, body: string) {
  const people = await q.many<{ user_id: string }>(
    `select user_id from organization_members where org_id=$1 and status='active' and (role in ('owner','admin') or user_id=$2)`,
    [t.orgId, job.created_by],
  );
  for (const p of people)
    await q.exec(
      `insert into notifications (org_id, user_id, category, title, body, ref, dedupe_key) values ($1,$2,'content',$3,$4,$5,$6)
       on conflict (org_id, user_id, dedupe_key) where dedupe_key is not null do nothing`,
      [t.orgId, p.user_id, title, body, JSON.stringify({ kind: 'content_job', id: job.id, jobCode: job.job_code }), `content:${job.id}:${key}`],
    );
}

export async function setState(q: Q, t: TenantCtx, job: any, to: string, cause: string, extra = '') {
  if (job.qline_state === to) return job;
  const r = await q.one(`update content_jobs set qline_state=$2, last_activity_at=now(), updated_at=now()${extra} where id=$1 returning *`, [job.id, to]);
  await insertEvent(q, t, job, { source: 'qline', key: `state:r${job.revision}:${to}:${cause}`, revision: job.revision, type: 'state.changed', message: `${job.qline_state.replace(/_/g, ' ')} → ${to.replace(/_/g, ' ')}`, detail: { from: job.qline_state, to, cause } });
  await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: 'content.job.state', targetRef: `content_job:${job.id}`, outcome: 'success', correlationId: t.correlationId, detail: { from: job.qline_state, to, cause } });
  return r;
}

/** The strongest valid report of the current revision: status rank, then sequence, then time. Never arrival order. */
async function bestReport(q: Q, job: any) {
  const rows = await q.many<any>(
    `select id, event_type, sequence, occurred_at, detail, raw_sha256 from content_job_events
     where job_id=$1 and source='external' and revision=$2 and event_type <> 'report.rejected'`,
    [job.id, job.revision],
  );
  const st = (r: any) => r.event_type.slice('report.'.length) as Status;
  rows.sort((a, b) => RANK[st(b)] - RANK[st(a)] || (b.sequence ?? -1) - (a.sequence ?? -1) || +new Date(b.occurred_at) - +new Date(a.occurred_at) || (a.id < b.id ? 1 : -1));
  return rows[0] ? { ...rows[0], status: st(rows[0]) } : null;
}

/**
 * Records one report against a job and applies it. Replays collapse on the event key; a different report claiming a
 * sequence that is already taken is rejected. A completed claim is verified against Drive outside the transaction.
 */
export async function ingest(t: TenantCtx, jobId: string, bytes: Uint8Array | 'too_large', ch: Channel, token?: string | null): Promise<IngestResult> {
  const rawSha = bytes === 'too_large' ? null : sha256(bytes);
  const parsed = bytes === 'too_large' ? parseReport(new Uint8Array(REPORT_MAX_BYTES + 1)) : parseReport(bytes);
  const via = ch.channel === 'drive' ? { channel: 'drive', reportFileId: ch.reportFileId, reportVersion: ch.reportVersion } : { channel: 'manual' };
  const first = await tx(t, async (q): Promise<IngestResult & { verify?: boolean }> => {
    let job = await q.one<any>('select * from content_jobs where id=$1 and workspace_id=$2 for update', [jobId, t.workspaceId]);
    if (!job) throw notFound('Content job');
    const reject = async (findings: Finding[], revision = job.revision) => {
      const key = ch.channel === 'drive' ? `rejected:drive:${ch.reportFileId}:${ch.reportVersion}` : `rejected:${rawSha}`;
      const ev = await insertEvent(q, t, job, { source: 'external', key, revision, type: 'report.rejected', message: findings.map((f) => f.message).join(' '), detail: { ...via, findings }, rawSha });
      if (!ev) return { outcome: 'duplicate' as const, findings };
      await nextAck(q, t, job, { status: 'rejected', findings, reportSha: rawSha, revision });
      await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: 'content.report.rejected', targetRef: `content_job:${job.id}`, outcome: 'denied', correlationId: t.correlationId, detail: { codes: findings.map((f) => f.code), ...via } });
      return { outcome: 'rejected' as const, findings };
    };
    if (!parsed.report) return reject(parsed.findings);
    const r = parsed.report;
    const bad = correlate(job, r);
    if (bad.length) return reject(bad, bad[0]!.code === 'job_mismatch' ? job.revision : Math.min(r.revision, job.revision));

    const now = Date.now();
    const at = r.occurredAt ? new Date(Math.min(Math.max(Date.parse(r.occurredAt), +new Date(job.issued_at)), now)) : new Date(now);
    const key = r.sequence != null ? `r${r.revision}:seq:${r.sequence}` : `r${r.revision}:sha:${rawSha!}`;
    const ev = await insertEvent(q, t, job, {
      source: 'external', key, revision: r.revision, sequence: r.sequence ?? null, type: `report.${r.status}`, message: r.message ?? null,
      fileIds: r.outputs.map((o) => o.driveFileId), detail: { ...via, status: r.status, outputs: r.outputs }, rawSha, occurredAt: at,
    });
    if (!ev) {
      const prior = await q.one<any>('select raw_sha256 from content_job_events where job_id=$1 and source=$2 and event_key=$3', [job.id, 'external', key]);
      if (prior?.raw_sha256 !== rawSha) return reject([{ code: 'sequence_conflict', message: `Another report already used sequence ${r.sequence}.` }]);
      // An exact replay changes nothing, except that a check interrupted earlier may run again.
      return { outcome: 'duplicate', findings: [], verify: job.qline_state === 'validating_output' };
    }
    await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: 'content.report.received', targetRef: `content_job:${job.id}`, outcome: 'success', correlationId: t.correlationId, detail: { status: r.status, sequence: r.sequence ?? null, ...via } });

    const best = (await bestReport(q, job))!;
    if (best.status !== job.external_status) job = await q.one('update content_jobs set external_status=$2, last_activity_at=now(), updated_at=now() where id=$1 returning *', [job.id, best.status]);
    else await q.exec('update content_jobs set last_activity_at=now() where id=$1', [job.id]);
    if (FROZEN.includes(job.qline_state) || best.id !== ev.id) return { outcome: 'recorded', findings: [] };

    const s = best.status;
    if (s === 'accepted' && ['prepared', 'dispatched'].includes(job.qline_state)) await setState(q, t, job, 'external_acknowledged', best.id);
    else if (s === 'in_progress' && ['prepared', 'dispatched', 'external_acknowledged'].includes(job.qline_state)) await setState(q, t, job, 'external_in_progress', best.id);
    else if (s === 'completed') {
      job = await setState(q, t, job, 'result_received', best.id, ', result_received_at=now()');
      await setState(q, t, job, 'validating_output', best.id, ', last_error=null');
      return { outcome: 'applied', findings: [], verify: true };
    } else if (s === 'failed' || s === 'blocked' || s === 'cancelled') {
      const to = s === 'cancelled' ? 'needs_manual_review' : s;
      await setState(q, t, job, to, best.id);
      await nextAck(q, t, job, { status: 'accepted', findings: s === 'cancelled' ? [{ code: 'external_cancelled', message: 'The editor reported the job as cancelled. Qline did not cancel it.' }] : [], reportSha: rawSha });
      await notifyJob(q, t, job, `r${job.revision}:${s}`, `${job.job_code}: editor reported ${s === 'cancelled' ? 'cancelled' : s}`, `"${job.title}" needs your attention. Open the job to see the report.`);
    }
    return { outcome: 'applied', findings: [] };
  });
  if (!first.verify) return first;
  const v = await verifyLatest(t, jobId, token);
  return { outcome: first.outcome, findings: v.findings, verification: v.result };
}

/** Qline's own check of a completed claim (docs/22 ADR-C2). Drive calls happen outside any transaction. */
export async function verifyLatest(t: TenantCtx, jobId: string, token?: string | null): Promise<{ result: 'verified' | 'rejected' | 'deferred' | 'stale'; findings: Finding[] }> {
  const snap = await tx(t, async (q) => {
    const job = await q.one<any>('select * from content_jobs where id=$1 and workspace_id=$2', [jobId, t.workspaceId]);
    const best = job && (await bestReport(q, job));
    const cfg = await q.one<any>('select * from content_drive_config where workspace_id=$1', [t.workspaceId]);
    return { job, best, cfg };
  });
  const { job, best, cfg } = snap;
  if (!job || job.qline_state !== 'validating_output' || best?.status !== 'completed') return { result: 'stale', findings: [] };
  const defer = async (msg: string) => {
    await tx(t, (q) => q.exec(`update content_jobs set last_error=$2, updated_at=now() where id=$1 and qline_state='validating_output'`, [job.id, msg.slice(0, 500)]));
    return { result: 'deferred' as const, findings: [{ code: 'verification_deferred', message: msg }] };
  };
  if (!cfg || cfg.status !== 'valid') return defer('The Drive folder mapping is not valid. Check it, then check reports again.');
  let tk = token;
  if (!tk) {
    try {
      tk = await mappedDrive(t, cfg);
    } catch (e) {
      return defer(e instanceof ApiError ? (e.detail ?? e.title) : 'Google Drive is not available.');
    }
  }
  const manifest = JSON.parse(job.manifest_json);
  const expectedName: string = manifest.expectedOutputs[0].fileName;
  const qa: string = cfg.roles.ready_for_qa;
  const claimed: Report['outputs'] = best.detail.outputs ?? [];
  const findings: Finding[] = [];
  const perFile = new Map<string, { f: DriveFile | null; findings: Finding[]; claimed: Report['outputs'][number] }>();
  if (!claimed.length) findings.push({ code: 'no_outputs', message: 'The report says completed but lists no output file.' });
  if (claimed.length && !claimed.some((o) => o.name === expectedName)) findings.push({ code: 'missing_expected_output', message: `No output is named ${expectedName}.` });
  if (new Set(claimed.map((o) => o.driveFileId)).size !== claimed.length) findings.push({ code: 'duplicate_output', message: 'The same output file is listed twice.' });
  try {
    for (const o of claimed) {
      if (perFile.has(o.driveFileId)) continue;
      const ff: Finding[] = [];
      const add = (code: string, message: string) => ff.push({ code, message, fileId: o.driveFileId });
      let f: DriveFile | null = null;
      if (job.input_file_ids.includes(o.driveFileId)) add('output_is_input', 'The output is one of the source files.');
      try {
        f = await driveMeta(tk, o.driveFileId);
      } catch (e) {
        if (!(e instanceof ProviderHttpError) || ![403, 404].includes(e.status)) throw e;
        add(e.status === 404 ? 'output_not_found' : 'output_no_access', e.status === 404 ? 'Qline cannot find this file in Drive.' : 'Qline is not allowed to open this file.');
      }
      if (f) {
        const size = f.size == null ? null : Number(f.size);
        if (f.trashed) add('output_trashed', 'The file is in the trash.');
        if (f.mimeType === DRIVE_SHORTCUT) add('output_is_shortcut', 'The file is a shortcut, not the video itself.');
        if (!(f.parents?.length === 1 && f.parents[0] === qa)) add('output_outside_ready_for_qa', 'The file is not directly in the Ready for QA folder.');
        if (!f.mimeType.startsWith('video/')) add('output_not_video', `The file is not a video (${clean(f.mimeType).slice(0, 80)}).`);
        if (size == null || size < 1 || size > OUTPUT_MAX_BYTES) add('output_size', 'The file size is missing or out of bounds.');
        if (f.name !== o.name) add('output_name_mismatch', 'The file name in Drive differs from the report.');
        if (o.md5 && f.md5Checksum !== o.md5) add('output_checksum_mismatch', 'The MD5 checksum differs from the report.');
        if (o.sizeBytes != null && size !== o.sizeBytes) add('output_size_mismatch', 'The size differs from the report.');
      }
      perFile.set(o.driveFileId, { f, findings: ff, claimed: o });
      findings.push(...ff);
    }
    // Source files must be exactly what was issued (ADR-C3 point 4: folder permissions cannot stop an editor changing them).
    for (const i of manifest.inputs as any[]) {
      let f: DriveFile | null = null;
      try {
        f = await driveMeta(tk, i.driveFileId);
      } catch (e) {
        if (!(e instanceof ProviderHttpError) || ![403, 404].includes(e.status)) throw e;
        findings.push({ code: 'input_missing', message: `Source file ${clean(i.name).slice(0, 120)} can no longer be opened.`, fileId: i.driveFileId });
        continue;
      }
      const changed = (i.md5 && f.md5Checksum && f.md5Checksum !== i.md5) || (i.sizeBytes != null && f.size != null && Number(f.size) !== i.sizeBytes);
      if (f.trashed) findings.push({ code: 'input_trashed', message: `Source file ${clean(i.name).slice(0, 120)} is in the trash.`, fileId: i.driveFileId });
      else if (changed) findings.push({ code: 'input_changed', message: `Source file ${clean(i.name).slice(0, 120)} changed after the job was issued.`, fileId: i.driveFileId });
    }
  } catch (e) {
    // Only Drive or network trouble postpones the check; anything else is a bug and must surface.
    if (!(e instanceof ProviderHttpError) && !(e instanceof TypeError) && (e as any)?.name !== 'TimeoutError') throw e;
    const err = driveFailure(e);
    return defer(err.detail ? `${err.title}. ${err.detail}` : err.title);
  }

  return tx(t, async (q) => {
    let live = await q.one<any>('select * from content_jobs where id=$1 for update', [job.id]);
    const nowBest = live && (await bestReport(q, live));
    if (!live || live.qline_state !== 'validating_output' || live.revision !== job.revision || nowBest?.id !== best.id) return { result: 'stale' as const, findings };
    for (const [id, x] of perFile) {
      await q.exec(
        `insert into content_job_outputs (org_id, job_id, revision, drive_file_id, name, mime, size_bytes, md5, parent_id, web_view_link, version, verification, findings, verified_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
         on conflict (job_id, drive_file_id) do update set revision=excluded.revision, name=excluded.name, mime=excluded.mime, size_bytes=excluded.size_bytes, md5=excluded.md5,
           parent_id=excluded.parent_id, web_view_link=excluded.web_view_link, version=excluded.version, verification=excluded.verification, findings=excluded.findings, verified_at=now()`,
        [t.orgId, job.id, job.revision, id, clean(x.f?.name ?? x.claimed.name).slice(0, 255), x.f?.mimeType ?? 'unknown', x.f?.size ?? null, x.f?.md5Checksum ?? null,
          x.f?.parents?.[0] ?? null, x.f?.webViewLink ?? null, x.f?.version ?? null, x.findings.length || !x.f ? 'rejected' : 'verified', JSON.stringify(x.findings)],
      );
    }
    const ok = findings.length === 0;
    const verifiedIds = ok ? [...perFile.keys()] : [];
    await nextAck(q, t, live, { status: ok ? 'accepted' : 'rejected', findings, verifiedOutputIds: verifiedIds, reportSha: best.raw_sha256 });
    await insertEvent(q, t, live, { source: 'qline', key: `verify:r${live.revision}:${best.id}`, revision: live.revision, type: ok ? 'output.verified' : 'output.rejected', message: ok ? 'Qline checked the output in Drive.' : `Qline found ${findings.length} problem(s) with the output.`, fileIds: [...perFile.keys()], detail: { findings, validationVersion: VALIDATION_VERSION } });
    if (!ok) {
      await setState(q, t, live, 'needs_manual_review', `verify:${best.id}`, ', last_error=null');
      await notifyJob(q, t, live, `r${live.revision}:review:${best.id}`, `${live.job_code}: output needs review`, `Qline could not confirm the video for "${live.title}". Open the job to see what is wrong.`);
      return { result: 'rejected' as const, findings };
    }
    live = await setState(q, t, live, 'output_verified', `verify:${best.id}`, ', verified_at=now(), last_error=null');
    await createQaTask(q, t, live);
    await setState(q, t, live, 'awaiting_video_qa', `verify:${best.id}`);
    await notifyJob(q, t, live, `r${live.revision}:ready`, `${live.job_code}: video ready to review`, `Qline confirmed the video for "${live.title}" is in Ready for QA. Watch it before approving anything.`);
    return { result: 'verified' as const, findings };
  });
}

/**
 * The video QA step, created at most once per job (unique qa_task_id, set under the job lock). It is a plain human
 * task, not a mission: missions start model planning, and nothing from a report may reach a model. Its text is Qline's own.
 */
async function createQaTask(q: Q, t: TenantCtx, job: any) {
  if (job.qa_task_id) return job.qa_task_id;
  const task = await q.one<{ id: string }>(
    `insert into tasks (org_id, workspace_id, title, description, status, priority, assignee_id, source_kind, source_ref, created_by)
     values ($1,$2,$3,$4,'todo','high',$5,'connector',$6,$7) returning id`,
    [t.orgId, job.workspace_id, `Review video for ${job.job_code}`.slice(0, 300), `Watch the video for "${job.title}" in the Ready for QA folder and decide whether it can be used. Qline checked the file location, type, size and name only; it did not judge the content.`, job.created_by, `content_job:${job.id}`, 'workflow:content_handoff'],
  );
  await q.exec('update content_jobs set qa_task_id=$2 where id=$1 and qa_task_id is null', [job.id, task!.id]);
  await insertEvent(q, t, job, { source: 'qline', key: 'qa.created', revision: job.revision, type: 'qa.created', message: 'Review task created.', detail: { taskId: task!.id } });
  await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: 'content.job.qa_created', targetRef: `content_job:${job.id}`, outcome: 'success', correlationId: t.correlationId, detail: { taskId: task!.id } });
  return task!.id;
}

/** Verified outputs must stay as they were checked. Any change after verification is a tamper finding. */
async function tamperCheck(t: TenantCtx, token: string, qa: string) {
  const jobs = await tx(t, (q) =>
    q.many<any>(
      `select j.id, o.drive_file_id, o.md5, o.size_bytes, o.name, o.parent_id, o.version from content_jobs j join content_job_outputs o on o.job_id=j.id and o.revision=j.revision
       where j.workspace_id=$1 and j.qline_state in ('output_verified','awaiting_video_qa') and o.verification='verified' order by j.last_activity_at desc limit $2`,
      [t.workspaceId, TAMPER_JOBS_PER_CHECK * 4],
    ),
  );
  let tampered = 0;
  for (const o of jobs) {
    let f: DriveFile | null = null;
    const problems: string[] = [];
    try {
      f = await driveMeta(token, o.drive_file_id);
    } catch (e) {
      if (!(e instanceof ProviderHttpError) || ![403, 404].includes(e.status)) throw e;
      problems.push('it can no longer be opened');
    }
    if (f) {
      if (f.trashed) problems.push('it was moved to the trash');
      if (!(f.parents?.length === 1 && f.parents[0] === qa)) problems.push('it was moved out of Ready for QA');
      if (f.name !== o.name) problems.push('it was renamed');
      if ((o.md5 && f.md5Checksum !== o.md5) || (o.size_bytes != null && Number(f.size) !== Number(o.size_bytes))) problems.push('its content changed');
    }
    if (!problems.length) continue;
    const fp = f ? `${f.md5Checksum ?? ''}:${f.size ?? ''}:${f.version ?? ''}:${f.trashed ? 't' : ''}:${(f.parents ?? []).join(',')}` : 'gone';
    const changed = await tx(t, async (q) => {
      const job = await q.one<any>('select * from content_jobs where id=$1 for update', [o.id]);
      if (!job) return false;
      const ev = await insertEvent(q, t, job, { source: 'drive', key: `tamper:${o.drive_file_id}:${sha256(fp).slice(0, 16)}`, revision: job.revision, type: 'output.tampered', message: `The verified video changed after Qline checked it: ${problems.join(', ')}.`, fileIds: [o.drive_file_id], detail: { problems } });
      if (!ev) return false;
      await q.exec(`update content_job_outputs set verification='rejected', findings = findings || $3::jsonb where job_id=$1 and drive_file_id=$2`, [job.id, o.drive_file_id, JSON.stringify([{ code: 'output_tampered', message: problems.join(', '), fileId: o.drive_file_id }])]);
      if (job.qline_state !== 'needs_manual_review') await setState(q, t, job, 'needs_manual_review', `tamper:${ev.id}`);
      await notifyJob(q, t, job, `tamper:${ev.id}`, `${job.job_code}: verified video changed`, `The video for "${job.title}" changed after Qline checked it. Review it again before using it.`);
      return true;
    });
    if (changed) tampered++;
  }
  return tampered;
}

const jobDetailRow = (q: Q, id: string) => q.one(`select ${JOB_COLS} from content_jobs where id=$1`, [id]);

/** Manual ingestion: the raw result.json as the request body, validated exactly like a file read from Drive. */
contentReportRoutes.post('/content/jobs/:id/ingest', async (c) => {
  const t = need(c, 'agents.use');
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > REPORT_MAX_BYTES) throw new ApiError(413, 'REPORT_TOO_LARGE', 'Report too large', `Reports can be at most ${REPORT_MAX_BYTES / 1024} KB.`);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength > REPORT_MAX_BYTES) throw new ApiError(413, 'REPORT_TOO_LARGE', 'Report too large', `Reports can be at most ${REPORT_MAX_BYTES / 1024} KB.`);
  const job = await tx(t, (q) => jobOrThrow(q, t, c.req.param('id')));
  const r = await ingest(t, job.id, buf, { channel: 'manual' });
  const row = await tx(t, (q) => jobDetailRow(q, job.id));
  return c.json({ ...r, job: jobOut(row) });
});

/** Re-runs Qline's check of the latest completed claim (for example after Drive was unavailable). */
contentReportRoutes.post('/content/jobs/:id/verify', async (c) => {
  const t = need(c, 'agents.use');
  const job = await tx(t, (q) => jobOrThrow(q, t, c.req.param('id')));
  if (job.qline_state !== 'validating_output') throw conflict('NOT_VALIDATING', 'This job is not waiting for an output check.');
  const v = await verifyLatest(t, job.id);
  const row = await tx(t, (q) => jobDetailRow(q, job.id));
  return c.json({ verification: v.result, findings: v.findings, job: jobOut(row) });
});

contentReportRoutes.get('/content/jobs/:id/ack', async (c) => {
  const t = need(c, 'documents.read');
  const version = c.req.query('version');
  const { job, ack } = await tx(t, async (q) => {
    const job = await jobOrThrow(q, t, c.req.param('id'));
    const ack = await q.one<any>(
      `select * from content_job_acks where job_id=$1 and ($2::int is null or version=$2) order by version desc limit 1`,
      [job.id, version && /^\d{1,6}$/.test(version) ? Number(version) : null],
    );
    return { job, ack };
  });
  if (!ack) throw notFound('Acknowledgement');
  const json = ackJson(job.job_code, ack);
  if (sha256(json) !== ack.sha256) throw integrity();
  return download(json, 'application/json; charset=utf-8', `${job.job_code}-r${ack.revision}.ack-${ack.version}.json`);
});

/**
 * "Check reports": reads result files from the mapped Reports folder (read-only), ingests the ones named after a job,
 * then re-checks verified outputs for tampering. Files already read at the same Drive version are skipped.
 */
/**
 * Reads new result files from the Reports folder (each Drive version once), applies them, then checks verified outputs
 * for tampering. Used by "Check reports" and by background change tracking. Throws an ApiError on Drive trouble, after
 * recording it on the config row.
 */
export async function checkReports(t: TenantCtx, cfg: any, token: string) {
  const folder: string = cfg.roles.external_reports;
  const summary = { listed: 0, read: 0, applied: 0, duplicates: 0, rejected: 0, recorded: 0, alreadyRead: 0, tampered: 0, deferred: 0, skipped: [] as { fileId: string; name: string; reason: string }[], truncated: false };
  const skip = (f: DriveFile, reason: string) => summary.skipped.length < 50 && summary.skipped.push({ fileId: f.id, name: clean(f.name).slice(0, 120), reason });
  try {
    const files: DriveFile[] = [];
    let page: string | null = null;
    for (let i = 0; i < LIST_PAGES; i++) {
      const r = await driveChildren(token, folder, page);
      files.push(...r.files);
      page = r.nextPageToken;
      if (!page) break;
    }
    summary.truncated = !!page;
    summary.listed = files.length;
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    for (const f of files) {
      if (f.mimeType === DRIVE_FOLDER || f.mimeType === DRIVE_SHORTCUT) {
        skip(f, f.mimeType === DRIVE_FOLDER ? 'folder' : 'shortcut');
        continue;
      }
      const m = f.name.match(REPORT_NAME);
      if (!m) {
        skip(f, 'name_not_a_report');
        continue;
      }
      const job = await tx(t, (q) => q.one<any>('select id from content_jobs where workspace_id=$1 and job_code=$2', [t.workspaceId, m[1]]));
      if (!job) {
        skip(f, 'unknown_job');
        continue;
      }
      const version = String(f.version ?? f.md5Checksum ?? f.modifiedTime ?? '0');
      const seen = await tx(t, (q) => q.one('select 1 from content_job_events where job_id=$1 and source=$2 and detail->>$3=$4 and detail->>$5=$6 limit 1', [job.id, 'external', 'reportFileId', f.id, 'reportVersion', version]));
      if (seen) {
        summary.alreadyRead++;
        continue;
      }
      if (summary.read >= REPORTS_PER_CHECK) {
        summary.truncated = true;
        break;
      }
      summary.read++;
      let bytes: Uint8Array | 'too_large';
      try {
        if (f.size != null && Number(f.size) > REPORT_MAX_BYTES) throw new ProviderHttpError('too large', 413);
        bytes = (await driveDownload(token, f, REPORT_MAX_BYTES)).bytes;
      } catch (e) {
        if (!(e instanceof ProviderHttpError) || ![413, 415].includes(e.status)) throw e;
        bytes = 'too_large'; // recorded as a rejected report; the content is never kept
      }
      const r = await ingest(t, job.id, bytes, { channel: 'drive', reportFileId: f.id, reportVersion: version }, token);
      if (r.outcome === 'applied') summary.applied++;
      else if (r.outcome === 'duplicate') summary.duplicates++;
      else if (r.outcome === 'rejected') summary.rejected++;
      else summary.recorded++;
      if (r.verification === 'deferred') summary.deferred++;
    }
    summary.tampered = await tamperCheck(t, token, cfg.roles.ready_for_qa);
  } catch (e) {
    const err = driveFailure(e);
    await tx(t, (q) => q.exec('update content_drive_config set last_reports_check_at=now(), last_error=$2 where workspace_id=$1', [t.workspaceId, (err.detail ?? err.title).slice(0, 500)]));
    throw err;
  }
  await tx(t, async (q) => {
    await q.exec('update content_drive_config set last_reports_check_at=now(), last_reports_check=$2 where workspace_id=$1', [t.workspaceId, JSON.stringify(summary)]);
    await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: 'content.reports_checked', targetRef: `workspace:${t.workspaceId}`, outcome: 'success', correlationId: t.correlationId, detail: { ...summary, skipped: summary.skipped.length } });
  });
  return summary;
}

contentReportRoutes.post('/content/reports/check', async (c) => {
  const t = need(c, 'agents.use');
  const cfg = await tx(t, (q) => q.one<any>('select * from content_drive_config where workspace_id=$1', [t.workspaceId]));
  if (!cfg) throw conflict('NOT_CONFIGURED', 'Map the Drive folders first.');
  if (cfg.status !== 'valid') throw conflict('NOT_VALIDATED', 'Check the folder mapping first.');
  if (!cfg.roles.external_reports) throw conflict('NO_REPORTS_FOLDER', 'Map a Reports folder to check reports from Drive, or paste a report into the job.');
  const token = await mappedDrive(t, cfg);
  return c.json(await checkReports(t, cfg, token));
});
