import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env, type TenantCtx } from '../core/context';
import { ApiError, badRequest, conflict } from '../core/errors';
import { body, query } from '../core/validate';
import { hasScope } from '../integrations/oauth';
import { DRIVE_FOLDER, DRIVE_SHORTCUT, driveChildren, driveMeta, ProviderHttpError, type DriveFile } from '../integrations/connectors';
import { connOrThrow, tokenFor } from './integrations';

/**
 * Content handoff, Slice 1 (docs/22 ADR-C1). Jazz maps Drive folders by ID under one root; Qline checks that every
 * mapped folder really sits inside that root, then indexes the files inside the mapped folders.
 * Read-only: only files.get and files.list are called. Nothing in Drive is created, moved, renamed or shared.
 */
export const contentRoutes = new Hono<Env>();

const DRIVE_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/, 'Not a Drive folder ID');
const OPTIONAL_ROLES = ['incoming', 'external_reports', 'acknowledged', 'completed', 'failed', 'logs'] as const;
const MAPPING = z
  .object({
    rootFolderId: DRIVE_ID,
    roles: z
      .object({
        assets: z.array(DRIVE_ID).min(1).max(10),
        ready_for_qa: DRIVE_ID,
        incoming: DRIVE_ID.optional(),
        external_reports: DRIVE_ID.optional(),
        acknowledged: DRIVE_ID.optional(),
        completed: DRIVE_ID.optional(),
        failed: DRIVE_ID.optional(),
        logs: DRIVE_ID.optional(),
      })
      .strict(),
  })
  .strict();
type Roles = z.infer<typeof MAPPING>['roles'];

export const PARENT_WALK_LIMIT = 20;
export const INDEX_DEPTH_LIMIT = 8;
export const INDEX_ITEM_LIMIT = 5000;
const INDEX_CONCURRENCY = 2;

/** [role, folderId] for every mapped folder except the root. */
function roleFolders(roles: Roles): [string, string][] {
  const out: [string, string][] = roles.assets.map((id) => ['assets', id]);
  out.push(['ready_for_qa', roles.ready_for_qa]);
  for (const r of OPTIONAL_ROLES) {
    const id = roles[r];
    if (id) out.push([r, id]);
  }
  return out;
}

const COLS = 'root_folder_id, roles, status, validation, validated_at, last_sync_at, last_sync, last_success_at, last_error, updated_at';
const publicConfig = (r: any) =>
  r
    ? {
        status: r.status,
        rootFolderId: r.root_folder_id,
        roles: r.roles,
        validation: r.validation,
        validatedAt: r.validated_at,
        lastSyncAt: r.last_sync_at,
        lastSync: r.last_sync,
        lastSuccessAt: r.last_success_at,
        lastError: r.last_error,
        updatedAt: r.updated_at,
      }
    : { status: 'unconfigured', rootFolderId: null, roles: null, validation: null, validatedAt: null, lastSyncAt: null, lastSync: null, lastSuccessAt: null, lastError: null, updatedAt: null };

/** A Drive failure as an API error the app can show. 403/404 are handled by the callers (they mean a folder). */
function driveFailure(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const s = e instanceof ProviderHttpError ? e.status : 0;
  if (s === 401) return new ApiError(409, 'RECONNECT_REQUIRED', 'Reconnect Google', 'Google did not accept the saved sign-in. Reconnect Google in Integrations.');
  if (s === 429 || s >= 500 || s === 0) return new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Google Drive is not answering', 'Try again in a few minutes.');
  return new ApiError(502, 'INTEGRATION_ERROR', 'Google Drive request failed', (e as Error).message);
}
const isAccessLost = (e: unknown) => e instanceof ProviderHttpError && (e.status === 403 || e.status === 404);

async function driveToken(t: TenantCtx) {
  const conn = await connOrThrow(t, 'google');
  if (!hasScope(conn, 'drive.readonly')) throw new ApiError(409, 'SCOPE_MISSING', 'Allow Google Drive first', 'Reconnect Google and tick Google Drive.');
  return { conn, token: await tokenFor(t, conn) };
}

// ---- Validation -------------------------------------------------------------------------------

type FolderCheck = { role: string; folderId: string; name: string | null; ok: boolean; reason: string | null };

/**
 * Checks the root and walks each mapped folder's parent chain up to the root (at most PARENT_WALK_LIMIT steps).
 * Rejects shortcuts, non-folders, trashed folders, folders in another shared drive, the root itself, and anything whose
 * chain does not reach the root.
 */
export async function validateMapping(token: string, rootFolderId: string, roles: Roles) {
  const cache = new Map<string, DriveFile>();
  const get = async (id: string) => {
    let f = cache.get(id);
    if (!f) cache.set(id, (f = await driveMeta(token, id)));
    return f;
  };
  let root: DriveFile;
  try {
    root = await get(rootFolderId);
  } catch (e) {
    if (isAccessLost(e)) return { ok: false, root: { folderId: rootFolderId, name: null, ok: false, reason: 'no_access' }, folders: [] as FolderCheck[] };
    throw driveFailure(e);
  }
  const rootReason = root.mimeType === DRIVE_SHORTCUT ? 'shortcut' : root.mimeType !== DRIVE_FOLDER ? 'not_a_folder' : root.trashed ? 'trashed' : null;
  const rootCheck = { folderId: root.id, name: root.name, ok: !rootReason, reason: rootReason };
  const folders: FolderCheck[] = [];
  for (const [role, folderId] of roleFolders(roles)) {
    let reason: string | null = null;
    let name: string | null = null;
    try {
      const f = await get(folderId);
      name = f.name;
      if (f.mimeType === DRIVE_SHORTCUT) reason = 'shortcut';
      else if (f.mimeType !== DRIVE_FOLDER) reason = 'not_a_folder';
      else if (f.trashed) reason = 'trashed';
      else if (f.id === root.id) reason = 'is_root';
      else if ((f.driveId ?? null) !== (root.driveId ?? null)) reason = 'different_drive';
      else {
        reason = 'too_deep';
        let cur = f;
        for (let step = 0; step < PARENT_WALK_LIMIT; step++) {
          const parent = cur.parents?.[0];
          if (!parent) {
            reason = 'outside_root';
            break;
          }
          if (parent === root.id) {
            reason = null;
            break;
          }
          cur = await get(parent);
          if (cur.trashed) {
            reason = 'trashed_parent';
            break;
          }
        }
      }
    } catch (e) {
      if (!isAccessLost(e)) throw driveFailure(e);
      reason = 'no_access';
    }
    folders.push({ role, folderId, name, ok: !reason, reason });
  }
  return { ok: rootCheck.ok && folders.every((f) => f.ok), root: rootCheck, folders };
}

// ---- Indexing ---------------------------------------------------------------------------------

export interface IndexedFile {
  file: DriveFile;
  role: string;
  parentId: string;
  depth: number;
  state: 'indexed' | 'skipped_shortcut';
}

/**
 * Breadth-first listing of the mapped folders only. Bounded by depth, total items and concurrency.
 * Shortcuts are recorded as skipped and never followed. A folder nested inside another mapped folder keeps its own role.
 */
export async function indexFolders(token: string, start: [string, string][]) {
  const found = new Map<string, IndexedFile>();
  const visited = new Set(start.map(([, id]) => id));
  let seen = 0;
  let truncated: 'item_limit' | 'depth_limit' | null = null;
  let level = start.map(([role, folderId]) => ({ role, folderId, depth: 0 }));
  while (level.length && truncated !== 'item_limit') {
    const next: typeof level = [];
    let i = 0;
    const worker = async () => {
      while (i < level.length && truncated !== 'item_limit') {
        const it = level[i++]!;
        let page: string | null = null;
        do {
          let r;
          try {
            r = await driveChildren(token, it.folderId, page);
          } catch (e) {
            throw Object.assign(e as Error, { role: it.role, depth: it.depth });
          }
          for (const f of r.files) {
            if (++seen > INDEX_ITEM_LIMIT) {
              truncated = 'item_limit';
              break;
            }
            if (f.trashed || (f.parents && !f.parents.includes(it.folderId))) continue;
            if (f.mimeType === DRIVE_FOLDER) {
              if (visited.has(f.id)) continue;
              if (it.depth + 1 > INDEX_DEPTH_LIMIT) {
                truncated ??= 'depth_limit';
                continue;
              }
              visited.add(f.id);
              next.push({ role: it.role, folderId: f.id, depth: it.depth + 1 });
            } else if (!found.has(f.id)) {
              found.set(f.id, { file: f, role: it.role, parentId: it.folderId, depth: it.depth, state: f.mimeType === DRIVE_SHORTCUT ? 'skipped_shortcut' : 'indexed' });
            }
          }
          page = r.nextPageToken;
        } while (page && truncated !== 'item_limit');
      }
    };
    await Promise.all(Array.from({ length: Math.min(INDEX_CONCURRENCY, level.length) }, worker));
    level = next;
  }
  return { files: [...found.values()], folders: visited.size, truncated };
}

const toRow = (x: IndexedFile) => {
  const f = x.file;
  const n = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    drive_file_id: f.id,
    name: String(f.name ?? '').slice(0, 500),
    mime: String(f.mimeType ?? '').slice(0, 200),
    parent_id: x.parentId,
    role: x.role,
    depth: x.depth,
    size_bytes: n(f.size),
    md5: f.md5Checksum ?? null,
    sha256: f.sha256Checksum ?? null,
    version: n(f.version),
    head_revision_id: f.headRevisionId ?? null,
    created_at_drive: f.createdTime ?? null,
    modified_at_drive: f.modifiedTime ?? null,
    width: f.width ?? null,
    height: f.height ?? null,
    duration_ms: f.durationMs ?? null,
    web_view_link: f.webViewLink ?? null,
    state: x.state,
  };
};

// ---- Routes -----------------------------------------------------------------------------------

contentRoutes.get('/content/drive-config', async (c) => {
  const t = need(c, 'documents.read');
  const row = await tx(t, (q) => q.one(`select ${COLS} from content_drive_config where workspace_id=$1`, [t.workspaceId]));
  return c.json(publicConfig(row));
});

/** Saves the mapping. Any change needs validation again, and files indexed under the old mapping stop counting. */
contentRoutes.put('/content/drive-config', async (c) => {
  const t = need(c, 'integrations.manage');
  const input = await body(c, MAPPING);
  const ids = [input.rootFolderId, ...roleFolders(input.roles).map(([, id]) => id)];
  if (new Set(ids).size !== ids.length) throw badRequest('Each folder can only have one role, and no role can use the root folder itself.');
  const row = await tx(t, async (q) => {
    const prev = await q.one<any>('select root_folder_id, roles from content_drive_config where workspace_id=$1 for update', [t.workspaceId]);
    const changed = !prev || prev.root_folder_id !== input.rootFolderId || JSON.stringify(prev.roles) !== JSON.stringify(input.roles);
    const r = await q.one(
      `insert into content_drive_config (org_id, workspace_id, root_folder_id, roles, status, updated_by) values ($1,$2,$3,$4,'needs_revalidation',$5)
       on conflict (workspace_id) do update set root_folder_id=excluded.root_folder_id, roles=excluded.roles, updated_by=excluded.updated_by, updated_at=now(),
         status = case when $6 then 'needs_revalidation' else content_drive_config.status end,
         validation = case when $6 then '{}'::jsonb else content_drive_config.validation end,
         validated_at = case when $6 then null else content_drive_config.validated_at end
       returning ${COLS}`,
      [t.orgId, t.workspaceId, input.rootFolderId, JSON.stringify(input.roles), t.userId, changed],
    );
    if (changed) {
      await q.exec(`update content_assets set state='removed' where workspace_id=$1 and state <> 'removed'`, [t.workspaceId]);
      await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'content.drive_config.updated', targetRef: `workspace:${t.workspaceId}`, correlationId: t.correlationId, detail: { rootFolderId: input.rootFolderId, folders: ids.length - 1 } });
    }
    return r;
  });
  return c.json(publicConfig(row));
});

contentRoutes.post('/content/drive-config/validate', async (c) => {
  const t = need(c, 'integrations.manage');
  const cfg = await tx(t, (q) => q.one<any>('select *, updated_at::text as version_tag from content_drive_config where workspace_id=$1', [t.workspaceId]));
  if (!cfg) throw conflict('NOT_CONFIGURED', 'Map the Drive folders first.');
  const { conn, token } = await driveToken(t);
  const v = await validateMapping(token, cfg.root_folder_id, cfg.roles);
  const validation = { ...v, accountEmail: conn.account_email ?? null };
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `update content_drive_config set status=$3, validation=$4, validated_at=now(), connection_id=$5, last_error=null, updated_at=now()
       where workspace_id=$1 and updated_at::text=$2 returning ${COLS}`,
      [t.workspaceId, cfg.version_tag, v.ok ? 'valid' : 'invalid', JSON.stringify(validation), conn.id],
    );
    if (!r) throw conflict('STALE_CONFIG', 'The folder mapping changed while it was being checked. Check it again.');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'content.drive_config.validated', targetRef: `workspace:${t.workspaceId}`, outcome: v.ok ? 'valid' : 'invalid', correlationId: t.correlationId, detail: { rejected: v.folders.filter((f) => !f.ok).map((f) => `${f.role}:${f.reason}`).concat(v.root.ok ? [] : [`root:${v.root.reason}`]) } });
    return r;
  });
  return c.json(publicConfig(row));
});

/**
 * "Sync now": indexes the mapped folders. Drive calls run outside any database transaction; the results are written in
 * one transaction, and only if the mapping did not change meanwhile.
 * shortcut: runs inline in the request with no automatic retry; run 5 moves it to a durable job with backoff.
 */
contentRoutes.post('/content/sync', async (c) => {
  const t = need(c, 'integrations.manage');
  const cfg = await tx(t, (q) => q.one<any>('select *, validated_at::text as validated_tag from content_drive_config where workspace_id=$1', [t.workspaceId]));
  if (!cfg) throw conflict('NOT_CONFIGURED', 'Map the Drive folders first.');
  if (cfg.status !== 'valid') throw conflict('NOT_VALIDATED', 'Check the folder mapping before syncing.');
  const { conn, token } = await driveToken(t);
  if (cfg.connection_id !== conn.id || (cfg.validation?.accountEmail ?? null) !== (conn.account_email ?? null)) {
    await tx(t, (q) => q.exec(`update content_drive_config set status='needs_revalidation', last_error=$2, updated_at=now() where workspace_id=$1`, [t.workspaceId, 'The Google account changed. Check the folder mapping again.']));
    throw conflict('NEEDS_REVALIDATION', 'The Google account changed. Check the folder mapping again.');
  }
  const started = new Date();
  const fail = async (msg: string, status?: string) =>
    tx(t, (q) => q.exec(`update content_drive_config set last_sync_at=now(), last_error=$2, status=coalesce($3, status) where workspace_id=$1`, [t.workspaceId, msg, status ?? null]));
  let r;
  try {
    r = await indexFolders(token, roleFolders(cfg.roles));
  } catch (e) {
    if (isAccessLost(e)) {
      const role = (e as any).role ?? 'a mapped folder';
      const msg = `Folder access lost: Qline can no longer open ${role === 'a mapped folder' ? role : `the ${role} folder`}${(e as any).depth ? ' (or a folder inside it)' : ''}.`;
      await fail(msg, (e as any).depth ? undefined : 'needs_revalidation');
      throw new ApiError(409, 'FOLDER_ACCESS_LOST', 'Folder access lost', msg);
    }
    const err = driveFailure(e);
    await fail(err.detail ?? err.title);
    throw err;
  }
  const rows = r.files.map(toRow);
  const summary = {
    indexed: rows.filter((x) => x.state === 'indexed').length,
    skippedShortcuts: rows.filter((x) => x.state === 'skipped_shortcut').length,
    folders: r.folders,
    truncated: r.truncated,
    removed: 0,
    durationMs: Date.now() - started.getTime(),
  };
  const row = await tx(t, async (q) => {
    const live = await q.one<any>(`select validated_at::text as tag, status from content_drive_config where workspace_id=$1 for update`, [t.workspaceId]);
    if (!live || live.tag !== cfg.validated_tag || live.status !== 'valid') throw conflict('STALE_CONFIG', 'The folder mapping changed during the sync. Sync again.');
    for (let i = 0; i < rows.length; i += 500) {
      await q.exec(
        `insert into content_assets (org_id, workspace_id, drive_file_id, name, mime, parent_id, role, depth, size_bytes, md5, sha256, version, head_revision_id,
           created_at_drive, modified_at_drive, width, height, duration_ms, web_view_link, state, last_seen_at)
         select $1, $2, x.drive_file_id, x.name, x.mime, x.parent_id, x.role, x.depth, x.size_bytes, x.md5, x.sha256, x.version, x.head_revision_id,
           x.created_at_drive, x.modified_at_drive, x.width, x.height, x.duration_ms, x.web_view_link, x.state, now()
         from jsonb_to_recordset($3::jsonb) as x(drive_file_id text, name text, mime text, parent_id text, role text, depth int, size_bytes bigint, md5 text, sha256 text,
           version bigint, head_revision_id text, created_at_drive timestamptz, modified_at_drive timestamptz, width int, height int, duration_ms bigint, web_view_link text, state text)
         on conflict (workspace_id, drive_file_id) do update set name=excluded.name, mime=excluded.mime, parent_id=excluded.parent_id, role=excluded.role, depth=excluded.depth,
           size_bytes=excluded.size_bytes, md5=excluded.md5, sha256=excluded.sha256, version=excluded.version, head_revision_id=excluded.head_revision_id,
           created_at_drive=excluded.created_at_drive, modified_at_drive=excluded.modified_at_drive, width=excluded.width, height=excluded.height,
           duration_ms=excluded.duration_ms, web_view_link=excluded.web_view_link, state=excluded.state, last_seen_at=now()`,
        [t.orgId, t.workspaceId, JSON.stringify(rows.slice(i, i + 500))],
      );
    }
    // Only a complete listing may conclude that a file is gone.
    if (!r.truncated) {
      const gone = await q.many(`update content_assets set state='removed' where workspace_id=$1 and state <> 'removed' and last_seen_at < $2 returning id`, [t.workspaceId, started]);
      summary.removed = gone.length;
    }
    const u = await q.one(
      `update content_drive_config set last_sync_at=now(), last_success_at=now(), last_error=$2, last_sync=$3, updated_at=updated_at where workspace_id=$1 returning ${COLS}`,
      [t.workspaceId, r.truncated ? `Sync stopped early (${r.truncated === 'item_limit' ? `more than ${INDEX_ITEM_LIMIT} items` : `folders deeper than ${INDEX_DEPTH_LIMIT} levels were skipped`}).` : null, JSON.stringify(summary)],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'content.drive_synced', targetRef: `workspace:${t.workspaceId}`, correlationId: t.correlationId, detail: summary });
    return u;
  });
  return c.json({ ...publicConfig(row), sync: summary });
});

contentRoutes.get('/content/assets', async (c) => {
  const t = need(c, 'documents.read');
  const p = query(
    c,
    z.object({
      role: z.string().regex(/^[a-z_]{1,40}$/).optional(),
      q: z.string().trim().max(100).optional(),
      state: z.enum(['indexed', 'skipped_shortcut', 'removed', 'all']).default('indexed'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).max(INDEX_ITEM_LIMIT).default(0),
    }),
  );
  const items = await tx(t, (q) =>
    q.many(
      `select drive_file_id as "driveFileId", name, mime, role, parent_id as "parentId", depth, size_bytes as "sizeBytes", md5, version, width, height,
         duration_ms as "durationMs", modified_at_drive as "modifiedAt", web_view_link as "webViewLink", state, last_seen_at as "lastSeenAt"
       from content_assets where workspace_id=$1 and ($2::text is null or role=$2) and ($3 = 'all' or state=$3)
         and ($4::text is null or name ilike '%' || replace(replace(replace($4, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
       order by role, name, drive_file_id limit $5 offset $6`,
      [t.workspaceId, p.role ?? null, p.state, p.q || null, p.limit, p.offset],
    ),
  );
  return c.json({ items });
});
