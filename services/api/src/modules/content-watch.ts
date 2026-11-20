import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { audit } from '../core/audit';
import { tx, type Env, type TenantCtx } from '../core/context';
import { withTenant, type Q } from '../core/db';
import { env } from '../core/env';
import { ApiError, conflict } from '../core/errors';
import { DRIVE_FOLDER, DRIVE_SHORTCUT, driveChanges, driveStopChannel, driveWatchChanges, ProviderHttpError, type DriveChange } from '../integrations/connectors';
import { CancelledError, enqueue, kick, LeaseLostError, PermanentError, registerJob, type JobCtx } from '../runtime/jobs';
import { actorKind, fullIndex, holdsLease, loadConfig, mappedDrive, releaseSyncLease, roleFolders, takeSyncLease, toRow, upsertAssets, validateMapping, type IndexedFolder } from './content';
import { checkReports, insertEvent, notifyJob, setState, verifyLatest } from './content-reports';

/**
 * Content handoff, Slice 3 (docs/22 ADR-C4): Drive change tracking and reconciliation.
 *
 * - The change cursor (`start_page_token`) moves forward only in the same transaction that applies its page of changes,
 *   and only if the cursor is still the one this worker read and it still holds the workspace sync lease. A crash
 *   before the commit leaves the cursor where it was, so the page is read again; applying it twice is harmless.
 * - A webhook only says "something changed". Qline always re-reads with changes.list; the request body is never read.
 * - The 10-minute tick reconciles every workspace: it covers missed webhooks, expires and flags jobs, retries checks that
 *   Drive could not finish, and keeps the push channel alive.
 * - Read-only for files: changes.watch and channels.stop manage a notification channel, nothing else.
 */
export const contentHookRoutes = new Hono<Env>();

export const CHANNEL_TTL_MS = 7 * 86_400_000; // the documented maximum for the changes resource
export const RENEW_BEFORE_MS = 24 * 3_600_000;
export const CHANGE_PAGES_PER_RUN = 20;
export const STALE_AFTER_SECONDS = 72 * 3600;
const HOOK_BUCKET_MS = 30_000;
const DEFERRED_PER_RUN = 20;
const SWEEP_LIMIT = 200;
/** States that wait on the editor and end as `expired` when `expires_at` passes. */
const EXPIRABLE = ['prepared', 'dispatched', 'external_acknowledged', 'external_in_progress', 'result_received', 'blocked'];
/** States that wait on the editor and are flagged when nothing happens for STALE_AFTER_SECONDS. */
const QUIET = ['prepared', 'dispatched', 'external_acknowledged', 'external_in_progress'];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A tenant context for background work. Audits record it as the system, not a person. */
export function systemCtx(orgId: string, workspaceId: string, correlationId: string): TenantCtx {
  return { orgId, workspaceId, userId: 'system:content', email: '', name: '', sessionId: 'system', human: false, role: 'owner', correlationId } as unknown as TenantCtx;
}

/** Another sync holds the workspace lease. Retried with the runtime's jittered backoff; not recorded as a Drive error. */
class SyncBusy extends Error {}

// ---- Applying changes -------------------------------------------------------------------------

type Plan = { rows: Map<string, ReturnType<typeof toRow> | null>; rescan: boolean; mappingTouched: boolean };

function folderMap(cfg: any): Map<string, IndexedFolder> {
  const m = new Map<string, IndexedFolder>();
  for (const f of Array.isArray(cfg.folder_index) ? cfg.folder_index : []) if (f && typeof f.id === 'string') m.set(f.id, f);
  for (const [role, id] of roleFolders(cfg.roles)) if (!m.has(id)) m.set(id, { id, role, depth: 0 });
  return m;
}

/**
 * Decides what one page of changes means for the index. Only files whose parent is a mapped folder (or a folder found
 * inside one) are kept; everything else in the account is ignored and never stored. A folder appearing, moving or
 * disappearing inside the mapped tree triggers a full listing; a change to the root or a mapped folder triggers a
 * boundary check (ADR-C1).
 */
export function planChanges(cfg: any, folders: Map<string, IndexedFolder>, changes: DriveChange[]): Plan {
  const top = new Set([cfg.root_folder_id, ...roleFolders(cfg.roles).map(([, id]) => id)]);
  const plan: Plan = { rows: new Map(), rescan: false, mappingTouched: false };
  for (const c of changes) {
    if (c.changeType === 'drive' || !c.fileId) continue;
    const f = c.file;
    const gone = c.removed || !f || f.trashed === true;
    if (top.has(c.fileId)) {
      plan.mappingTouched = true;
      continue;
    }
    if (folders.has(c.fileId)) {
      // a known subfolder: a rename in place changes nothing; anything else needs a fresh listing
      if (gone || f!.mimeType !== DRIVE_FOLDER || !(f!.parents ?? []).some((p) => folders.has(p))) plan.rescan = true;
      continue;
    }
    if (gone) {
      plan.rows.set(c.fileId, null);
      continue;
    }
    const parent = (f!.parents ?? []).find((p) => folders.has(p));
    if (f!.mimeType === DRIVE_FOLDER) {
      if (parent) plan.rescan = true;
      continue;
    }
    if (!parent) {
      plan.rows.set(c.fileId, null); // moved out of the mapped folders (a no-op for files Qline never indexed)
      continue;
    }
    const fo = folders.get(parent)!;
    plan.rows.set(c.fileId, toRow({ file: f!, role: fo.role, parentId: parent, depth: fo.depth, state: f!.mimeType === DRIVE_SHORTCUT ? 'skipped_shortcut' : 'indexed' }));
  }
  return plan;
}

export interface SyncSummary {
  mode: 'changes' | 'rescan' | 'skipped';
  reason: string;
  rescan: null | 'first_sync' | 'stale_cursor' | 'folders_changed';
  pages: number;
  changes: number;
  applied: number;
  removed: number;
  more: boolean;
  mapping: null | 'valid' | 'invalid';
  reports: unknown;
  retriedChecks: number;
}

/**
 * One sync of a workspace under its sync lease: change pages from the cursor (or a full listing when there is no
 * usable cursor), then reports and outputs when anything changed, or always on reconciliation.
 */
export async function syncWorkspace(t: TenantCtx, o: { owner: string; beat?: () => Promise<void>; reason: 'hook' | 'reconcile' | 'follow_up' | 'manual' }): Promise<SyncSummary> {
  const out: SyncSummary = { mode: 'changes', reason: o.reason, rescan: null, pages: 0, changes: 0, applied: 0, removed: 0, more: false, mapping: null, reports: null, retriedChecks: 0 };
  const cfg = await loadConfig(t);
  if (!cfg || cfg.status !== 'valid') return { ...out, mode: 'skipped' };
  if (!(await takeSyncLease(t, o.owner))) throw new SyncBusy('Another Drive sync is running for this workspace.');
  try {
    const token = await mappedDrive(t, cfg);
    const beat = async () => {
      await o.beat?.();
      if (!(await takeSyncLease(t, o.owner, true))) throw conflict('SYNC_SUPERSEDED', 'Another Drive sync took over.');
    };
    let changed = false;
    const rescan = async (why: NonNullable<SyncSummary['rescan']>) => {
      out.mode = 'rescan';
      out.rescan = why;
      await fullIndex(t, cfg, token, o.owner, beat);
      changed = true;
    };
    if (cfg.cursor_status !== 'ok' || !cfg.start_page_token) await rescan(cfg.cursor_status === 'stale' ? 'stale_cursor' : 'first_sync');
    else {
      const folders = folderMap(cfg);
      let tok: string = cfg.start_page_token;
      for (;;) {
        if (out.pages >= CHANGE_PAGES_PER_RUN) {
          out.more = true;
          break;
        }
        await beat();
        let page;
        try {
          page = await driveChanges(token, tok);
        } catch (e) {
          // Drive refuses a page token it no longer knows: list everything again and take a fresh token.
          if (e instanceof ProviderHttpError && [400, 404, 410].includes(e.status)) {
            await tx(t, (q) => q.exec(`update content_drive_config set cursor_status='stale' where workspace_id=$1 and sync_lease_owner=$2`, [t.workspaceId, o.owner]));
            await rescan('stale_cursor');
            break;
          }
          throw e;
        }
        out.pages++;
        out.changes += page.changes.length;
        const plan = planChanges(cfg, folders, page.changes);
        const next = page.nextPageToken ?? page.newStartPageToken!;
        const upserts = [...plan.rows.values()].filter((r): r is NonNullable<typeof r> => r !== null);
        const gone = [...plan.rows.entries()].filter(([, r]) => r === null).map(([id]) => id);
        const removed = await tx(t, async (q) => {
          if (!(await holdsLease(q, t.workspaceId, o.owner))) return null;
          const live = await q.one<any>('select start_page_token, status, validated_at::text as tag from content_drive_config where workspace_id=$1', [t.workspaceId]);
          if (!live || live.start_page_token !== tok || live.status !== 'valid' || live.tag !== cfg.validated_tag) return null;
          if (upserts.length) await upsertAssets(q, t, upserts);
          const r = gone.length ? await q.many(`update content_assets set state='removed' where workspace_id=$1 and drive_file_id = any($2) and state <> 'removed' returning id`, [t.workspaceId, gone]) : [];
          await q.exec(`update content_drive_config set start_page_token=$2, last_sync_at=now(), last_success_at=now(), last_error=null where workspace_id=$1`, [t.workspaceId, next]);
          return r.length;
        });
        if (removed === null) throw conflict('SYNC_SUPERSEDED', 'The change cursor moved or the mapping changed during the sync.');
        out.applied += upserts.length;
        out.removed += removed;
        if (upserts.length || removed) changed = true;
        tok = next;
        if (plan.mappingTouched) {
          // The root or a mapped folder itself changed (renamed, moved, trashed, shared differently): check the boundary.
          const v = await validateMapping(token, cfg.root_folder_id, cfg.roles);
          out.mapping = v.ok ? 'valid' : 'invalid';
          if (!v.ok) {
            await tx(t, async (q) => {
              await q.exec(`update content_drive_config set status='invalid', validation=$2, last_error=$3, updated_at=now() where workspace_id=$1`, [
                t.workspaceId,
                JSON.stringify({ ...v, accountEmail: cfg.validation?.accountEmail ?? null }),
                'A mapped folder was moved, trashed or can no longer be opened. Check the folder mapping again.',
              ]);
              await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: 'content.drive_config.invalidated', targetRef: `workspace:${t.workspaceId}`, outcome: 'invalid', correlationId: t.correlationId, detail: { rejected: v.folders.filter((f) => !f.ok).map((f) => `${f.role}:${f.reason}`).concat(v.root.ok ? [] : [`root:${v.root.reason}`]) } });
            });
            return out;
          }
        }
        if (plan.rescan) {
          await rescan('folders_changed');
          break;
        }
        if (page.newStartPageToken) break;
      }
      if (out.more) {
        const key = `more:${t.workspaceId}:${sha256(tok).slice(0, 24)}`;
        await tx(t, (q) => enqueue(q, { orgId: t.orgId, kind: 'content.drive_sync', payload: { workspaceId: t.workspaceId, reason: 'follow_up' }, idempotencyKey: key, maxAttempts: 6, createdBy: 'system:content' }));
      }
    }
    const live = (await loadConfig(t)) ?? cfg;
    if (live.status === 'valid' && live.roles.external_reports && (changed || o.reason === 'reconcile')) out.reports = await checkReports(t, live, token);
    if (o.reason === 'reconcile') {
      const waiting = await tx(t, (q) => q.many<{ id: string }>(`select id from content_jobs where workspace_id=$1 and qline_state='validating_output' and last_error is not null order by updated_at limit $2`, [t.workspaceId, DEFERRED_PER_RUN]));
      for (const j of waiting) {
        await verifyLatest(t, j.id, token);
        out.retriedChecks++;
      }
    }
    await tx(t, (q) => q.exec('update content_drive_config set last_error=null, last_success_at=now() where workspace_id=$1 and sync_lease_owner=$2', [t.workspaceId, o.owner]));
    return out;
  } finally {
    await releaseSyncLease(t, o.owner).catch(() => {});
  }
}

// ---- Errors -----------------------------------------------------------------------------------

type Kind = 'retry' | 'reconnect' | 'access' | 'skip' | 'fail';
export function classify(e: unknown): { kind: Kind; message: string } {
  if (e instanceof ApiError) {
    const message = e.detail ?? e.title;
    if (['RECONNECT_REQUIRED', 'NOT_CONNECTED', 'SCOPE_MISSING'].includes(e.code)) return { kind: 'reconnect', message: `Reconnect Google: ${message}` };
    if (e.code === 'FOLDER_ACCESS_LOST') return { kind: 'access', message };
    if (['NEEDS_REVALIDATION', 'STALE_CONFIG', 'NOT_VALIDATED', 'NOT_CONFIGURED', 'SYNC_SUPERSEDED'].includes(e.code)) return { kind: 'skip', message };
    if (e.status === 503) return { kind: 'retry', message: 'Google Drive is not answering. Qline will try again.' };
    return { kind: 'fail', message };
  }
  if (e instanceof ProviderHttpError) {
    if (e.status === 401) return { kind: 'reconnect', message: 'Reconnect Google: Google did not accept the saved sign-in.' };
    // Drive also reports rate limits as 403 (userRateLimitExceeded), so a 403 on changes is retried, not fatal.
    if (e.status === 429 || e.status >= 500 || e.status === 403) return { kind: 'retry', message: 'Google Drive is not answering. Qline will try again.' };
    return { kind: 'fail', message: `Google Drive request failed: ${e.message}` };
  }
  const name = (e as Error)?.name;
  if (name === 'TypeError' || name === 'TimeoutError' || name === 'AbortError') return { kind: 'retry', message: 'Google Drive could not be reached. Qline will try again.' };
  console.error('content sync: unexpected error', (e as Error)?.message?.slice(0, 300));
  return { kind: 'retry', message: 'Drive sync failed. Qline will try again.' };
}

/** Records a Drive failure on the config row, then returns what the job should do: a value to finish with, or throws. */
async function settle(t: TenantCtx, e: unknown): Promise<{ skipped: string }> {
  if (e instanceof LeaseLostError || e instanceof CancelledError || e instanceof SyncBusy) throw e;
  const c = classify(e);
  if (c.kind === 'skip') return { skipped: c.message };
  await tx(t, (q) => q.exec('update content_drive_config set last_error=$2 where workspace_id=$1', [t.workspaceId, c.message.slice(0, 500)])).catch(() => {});
  if (c.kind === 'retry') throw Object.assign(new Error(c.message), { cause: e });
  throw new PermanentError(c.message);
}

// ---- Sweeps -----------------------------------------------------------------------------------

/** Expires jobs past `expires_at` and flags quiet ones. DB only; runs even when Drive is unavailable. */
export async function sweepJobs(t: TenantCtx) {
  return tx(t, async (q: Q) => {
    const expired = await q.many<any>(`select * from content_jobs where workspace_id=$1 and qline_state = any($2) and expires_at < now() order by expires_at limit $3 for update skip locked`, [t.workspaceId, EXPIRABLE, SWEEP_LIMIT]);
    for (const j of expired) {
      await setState(q, t, j, 'expired', 'expires_at');
      await notifyJob(q, t, j, `expired:r${j.revision}`, 'Content job expired', `${j.job_code} reached its expiry date without a finished result. Reissue it to try again.`);
    }
    const quiet = await q.many<any>(
      `select * from content_jobs where workspace_id=$1 and qline_state = any($2) and last_activity_at < now() - make_interval(secs => $3)
         and (stale_since is null or stale_since < last_activity_at) order by last_activity_at limit $4 for update skip locked`,
      [t.workspaceId, QUIET, STALE_AFTER_SECONDS, SWEEP_LIMIT],
    );
    for (const j of quiet) {
      const since = Math.floor(new Date(j.last_activity_at).getTime() / 1000);
      await q.exec('update content_jobs set stale_since=now() where id=$1', [j.id]); // last_activity_at is left alone on purpose
      await insertEvent(q, t, j, { source: 'qline', key: `stale:r${j.revision}:${since}`, revision: j.revision, type: 'job.stale', message: 'No update from the editor for 3 days.', detail: { lastActivityAt: j.last_activity_at } });
      await notifyJob(q, t, j, `stale:r${j.revision}:${since}`, 'Content job is quiet', `${j.job_code} has had no update for 3 days.`);
    }
    return { expired: expired.length, stale: quiet.length };
  });
}

// ---- Push channel -----------------------------------------------------------------------------

const CLEAR_PREV = `prev_channel_id=null, prev_channel_token_hash=null, prev_resource_id=null, prev_channel_expires_at=null`;

/**
 * Keeps one changes.watch channel per workspace while a webhook address is configured and the mapping is valid.
 * Renews when less than 24 h is left. The new channel is recorded before Drive is asked (so its first `sync` message is
 * recognised); the old one stays accepted as `prev_*` and is stopped only after the new one is confirmed.
 */
export async function ensureChannel(t: TenantCtx, cfg: any, token: string | null): Promise<string> {
  const address = env.driveWebhookUrl;
  const now = Date.now();
  const stop = async (id: string | null, rid: string | null) => {
    if (!token || !id || !rid) return false;
    return driveStopChannel(token, id, rid).then(
      () => true,
      () => false,
    );
  };
  if (!address || cfg.status !== 'valid') {
    if (!cfg.channel_id && !cfg.prev_channel_id) return 'off';
    await stop(cfg.channel_id, cfg.resource_id);
    await stop(cfg.prev_channel_id, cfg.prev_resource_id);
    await tx(t, (q) => q.exec(`update content_drive_config set channel_id=null, channel_token_hash=null, resource_id=null, channel_expires_at=null, ${CLEAR_PREV} where workspace_id=$1`, [t.workspaceId]));
    return 'stopped';
  }
  if (cfg.prev_channel_id && (new Date(cfg.prev_channel_expires_at ?? 0).getTime() < now || (await stop(cfg.prev_channel_id, cfg.prev_resource_id))))
    await tx(t, (q) => q.exec(`update content_drive_config set ${CLEAR_PREV} where workspace_id=$1 and prev_channel_id=$2`, [t.workspaceId, cfg.prev_channel_id]));
  if (cfg.channel_id && cfg.resource_id && new Date(cfg.channel_expires_at ?? 0).getTime() - now > RENEW_BEFORE_MS) return 'ok';
  if (!token || cfg.cursor_status !== 'ok' || !cfg.start_page_token) return 'waiting_for_cursor';
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const old = cfg.channel_id && cfg.resource_id ? { id: cfg.channel_id as string, rid: cfg.resource_id as string } : null;
  await tx(t, (q) =>
    q.exec(
      `update content_drive_config set
         prev_channel_id=case when $5 then channel_id else prev_channel_id end, prev_channel_token_hash=case when $5 then channel_token_hash else prev_channel_token_hash end,
         prev_resource_id=case when $5 then resource_id else prev_resource_id end, prev_channel_expires_at=case when $5 then channel_expires_at else prev_channel_expires_at end,
         channel_id=$2, channel_token_hash=$3, resource_id=null, channel_expires_at=$4 where workspace_id=$1`,
      [t.workspaceId, id, sha256(secret), new Date(now + CHANNEL_TTL_MS), !!old],
    ),
  );
  let w;
  try {
    w = await driveWatchChanges(token, cfg.start_page_token, { id, token: secret, address, expirationMs: now + CHANNEL_TTL_MS });
  } catch (e) {
    // Put the previous channel back (it is still open), or clear the pending one.
    await tx(t, (q) =>
      q.exec(
        `update content_drive_config set channel_id=prev_channel_id, channel_token_hash=prev_channel_token_hash, resource_id=prev_resource_id, channel_expires_at=prev_channel_expires_at, ${CLEAR_PREV}
         where workspace_id=$1 and channel_id=$2`,
        [t.workspaceId, id],
      ),
    );
    throw e;
  }
  await tx(t, async (q) => {
    await q.exec('update content_drive_config set resource_id=$3, channel_expires_at=$4, channel_renewed_at=now() where workspace_id=$1 and channel_id=$2', [t.workspaceId, id, w.resourceId, w.expiresAt]);
    await audit(q, { orgId: t.orgId, actorKind: actorKind(t), actorId: t.userId, action: old ? 'content.drive_channel.renewed' : 'content.drive_channel.opened', targetRef: `workspace:${t.workspaceId}`, outcome: 'success', correlationId: t.correlationId, detail: { channelId: id, expiresAt: w.expiresAt } });
  });
  if (old && (await stop(old.id, old.rid))) await tx(t, (q) => q.exec(`update content_drive_config set ${CLEAR_PREV} where workspace_id=$1 and prev_channel_id=$2`, [t.workspaceId, old.id]));
  return old ? 'renewed' : 'opened';
}

// ---- Jobs -------------------------------------------------------------------------------------

const ctxFor = (ctx: JobCtx) => systemCtx(ctx.job.org_id, ctx.job.payload.workspaceId, ctx.job.id);
const ownerFor = (ctx: JobCtx) => `job:${ctx.job.id}:${ctx.job.attempts}`;

/** Webhook and follow-up syncs. */
registerJob('content.drive_sync', async (ctx) => {
  const t = ctxFor(ctx);
  try {
    return await syncWorkspace(t, { owner: ownerFor(ctx), beat: () => ctx.heartbeat(), reason: ctx.job.payload.reason === 'follow_up' ? 'follow_up' : 'hook' });
  } catch (e) {
    return settle(t, e);
  }
});

/** The 10-minute reconciliation of one workspace. Each part runs even when an earlier one fails. */
registerJob('content.reconcile', async (ctx) => {
  const t = ctxFor(ctx);
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  out.sweeps = await sweepJobs(t);
  let failure: unknown = null;
  try {
    out.sync = await syncWorkspace(t, { owner: ownerFor(ctx), beat: () => ctx.heartbeat(), reason: 'reconcile' });
  } catch (e) {
    failure = e;
    out.sync = { error: classify(e).message };
  }
  try {
    const cfg = await loadConfig(t);
    if (cfg) {
      const token = cfg.status === 'valid' || cfg.channel_id || cfg.prev_channel_id ? await mappedDrive(t, cfg).catch(() => null) : null;
      out.channel = await ensureChannel(t, cfg, token);
    }
  } catch (e) {
    out.channel = 'error';
    out.channelError = classify(e).message;
  }
  await tx(t, (q) => q.exec('update content_drive_config set last_reconcile=$2 where workspace_id=$1', [t.workspaceId, JSON.stringify(out)]));
  if (failure) {
    if (failure instanceof SyncBusy) return { ...out, sync: { skipped: 'busy' } }; // the running sync covers it
    const s = await settle(t, failure);
    return { ...out, sync: s };
  }
  return out;
});

/** Tick step: queues one reconciliation per workspace whose last one is at least 10 minutes old. */
export async function runContentReconcile(o: { limit?: number; orgIds?: string[] } = {}) {
  const due = await withTenant({ orgId: null, userId: 'system:content' }, (q) => q.many<{ org_id: string; workspace_id: string }>('select * from qline_content_due($1)', [o.limit ?? 20]));
  let queued = 0;
  for (const d of due) {
    if (o.orgIds && !o.orgIds.includes(d.org_id)) continue;
    const created = await withTenant({ orgId: d.org_id, userId: 'system:content' }, async (q) => {
      // Claim this cycle with a compare-and-swap, so two ticks racing on the same workspace queue one job.
      const claim = await q.one<{ at: string }>(
        `update content_drive_config set last_reconciled_at=now() where workspace_id=$1
           and (last_reconciled_at is null or last_reconciled_at < now() - interval '10 minutes')
         returning last_reconciled_at::text as at`, [d.workspace_id]);
      if (!claim) return false;
      const busy = await q.one(`select 1 from jobs where kind='content.reconcile' and status in ('queued','running') and payload->>'workspaceId'=$1`, [d.workspace_id]);
      if (busy) return false;
      const j = await enqueue(q, { orgId: d.org_id, kind: 'content.reconcile', payload: { workspaceId: d.workspace_id }, idempotencyKey: `reconcile:${d.workspace_id}:${claim.at}`, maxAttempts: 6, createdBy: 'system:content' });
      return j.created;
    });
    if (created) queued++;
  }
  return { due: due.length, queued };
}

// ---- Webhook ----------------------------------------------------------------------------------

/**
 * Public: Google posts here when the watched account changes. Checks the channel ID, the channel token (by SHA-256,
 * constant time), the resource ID and the expiry. Unknown or mismatched channels get 404, which Google treats as a
 * final failure (no retry). `sync` messages are acknowledged without work. Otherwise one sync is queued per workspace
 * per 30 s and the request returns 204 at once.
 */
contentHookRoutes.post('/hooks/drive', async (c) => {
  const id = c.req.header('x-goog-channel-id') ?? '';
  const token = c.req.header('x-goog-channel-token') ?? '';
  const state = (c.req.header('x-goog-resource-state') ?? '').toLowerCase();
  const rid = c.req.header('x-goog-resource-id') ?? '';
  const refuse = () => c.json({ title: 'Not found', status: 404, code: 'NOT_FOUND' }, 404);
  if (!/^[0-9a-f-]{36}$/.test(id) || !token || token.length > 256) return refuse();
  const rows = await withTenant({ orgId: null, userId: 'system:drive-hook' }, (q) => q.many<any>('select * from qline_content_channel($1)', [id]));
  const row = rows[0];
  if (!row?.token_hash || !sameHex(sha256(token), row.token_hash)) return refuse();
  if (row.resource_id && rid !== row.resource_id) return refuse();
  if (!row.expires_at || new Date(row.expires_at).getTime() < Date.now()) return refuse();
  if (state === 'sync') return c.body(null, 204);
  const bucket = Math.floor(Date.now() / HOOK_BUCKET_MS);
  await withTenant({ orgId: row.org_id, userId: 'system:drive-hook' }, (q) =>
    enqueue(q, { orgId: row.org_id, kind: 'content.drive_sync', payload: { workspaceId: row.workspace_id, reason: 'hook' }, idempotencyKey: `hook:${row.workspace_id}:${bucket}`, maxAttempts: 6, createdBy: 'system:drive-hook' }),
  );
  kick();
  return c.body(null, 204);
});
