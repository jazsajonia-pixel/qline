import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { verifyAuditChain } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env } from '../core/context';
import { getPool } from '../core/db';
import { env } from '../core/env';
import { ApiError } from '../core/errors';
import { query, limitParam } from '../core/validate';
import { z } from 'zod';
import { storageConfigured, storageReady } from './imports';
import { runScheduledWorkflows } from './workflows';

// ---------------------------------------------------------------------------
// Integrations: honest catalogue (docs/09). Nothing is shown as connected
// unless a real OAuth app exists. Today only the built-in import is available.
// ---------------------------------------------------------------------------
export const CATALOGUE = [
  { id: 'file_import', name: 'File import', category: 'Data', status: 'available', detail: 'CSV, XLSX, JSON, TXT, MD, PDF and DOCX up to 10 MB.' },
  { id: 'google_gmail', name: 'Gmail', category: 'Email', status: 'not_configured', detail: 'Needs a verified Google OAuth app. Planned.' },
  { id: 'google_drive', name: 'Google Drive', category: 'Files', status: 'not_configured', detail: 'Needs a verified Google OAuth app. Planned.' },
  { id: 'google_calendar', name: 'Google Calendar', category: 'Calendar', status: 'not_configured', detail: 'Needs a verified Google OAuth app. Planned.' },
  { id: 'slack', name: 'Slack', category: 'Messaging', status: 'not_configured', detail: 'Needs a Slack app. Planned.' },
  { id: 'notion', name: 'Notion', category: 'Docs', status: 'not_configured', detail: 'Needs a Notion integration. Planned.' },
  { id: 'github', name: 'GitHub', category: 'Dev', status: 'not_configured', detail: 'Needs a GitHub app. Planned.' },
  { id: 'stripe', name: 'Stripe', category: 'Payments', status: 'not_configured', detail: 'Read-only revenue sync. Planned.' },
  { id: 'meta', name: 'Meta (Facebook / Instagram)', category: 'Marketing', status: 'not_configured', detail: 'Needs Meta app review. Planned.' },
] as const;

export const systemRoutes = new Hono<Env>();

// ---- AI status --------------------------------------------------------------
// AI is bring-your-own-key per organization (see modules/ai.ts); the server has no shared key.
export async function aiStatus(_force = false) {
  return { status: 'per_organization', model: null, detail: 'Each organization connects its own AI provider keys in Settings → AI providers.' };
}

systemRoutes.get('/health', (c) => c.json({ status: 'ok', version: env.version, time: new Date().toISOString() }));

systemRoutes.get('/health/ready', async (c) => {
  let db = false;
  try {
    await getPool().query('select 1');
    db = true;
  } catch {}
  const storage = await storageReady();
  const ai = await aiStatus();
  return c.json({ status: db ? 'ok' : 'degraded', checks: { database: db, storage, storageConfigured: storageConfigured(), ai: ai.status } }, db ? 200 : 503);
});

systemRoutes.get('/ai/status', requireUser, async (c) => c.json(await aiStatus(c.req.query('refresh') === '1')));

systemRoutes.get('/integrations', requireUser, requireTenant, (c) => c.json({ items: CATALOGUE }));
systemRoutes.post('/integrations/:id/connect', requireUser, requireTenant, (c) => {
  need(c, 'integrations.manage');
  const item = CATALOGUE.find((x) => x.id === c.req.param('id'));
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'Integration not found');
  if (item.id === 'file_import') return c.json({ ok: true, detail: 'File import is built in. Use Import in the app.' });
  throw new ApiError(501, 'CONNECTOR_NOT_CONFIGURED', `${item.name} is not configured`, item.detail);
});

// ---- Audit ------------------------------------------------------------------
systemRoutes.get('/audit', requireUser, requireTenant, async (c) => {
  const t = need(c, 'audit.read');
  const p = query(c, z.object({ limit: limitParam, before: z.coerce.number().int().optional(), action: z.string().max(60).optional() }));
  const items = await tx(t, (q) =>
    q.many(
      `select id, actor_kind, actor_id, action, target_ref, outcome, detail, at from audit_events
       where ($1::bigint is null or id < $1) and ($2::text is null or action like $2 || '%') order by id desc limit $3`,
      [p.before ?? null, p.action ?? null, p.limit],
    ),
  );
  return c.json({ items, next: items.length === p.limit ? items[items.length - 1].id : null });
});

systemRoutes.get('/audit/verify', requireUser, requireTenant, async (c) => {
  const t = need(c, 'audit.read');
  return c.json(await tx(t, (q) => verifyAuditChain(q, t.orgId)));
});

// ---- Export (JSON, owner/admin) --------------------------------------------
systemRoutes.get('/exports', requireUser, requireTenant, async (c) => {
  const t = need(c, 'export.run');
  const data = await tx(t, async (q) => {
    const tables = ['projects', 'tasks', 'companies', 'contacts', 'documents', 'memory_records', 'workflows', 'agents', 'configuration_versions'];
    const out: Record<string, unknown[]> = {};
    for (const tb of tables) {
      const cols = tb === 'documents' ? 'id, kind, title, body, folder, source_kind, source_ref, created_by, created_at, updated_at, deleted_at' : '*';
      out[tb] = await q.many(`select ${cols} from ${tb} order by created_at`);
    }
    out.organization = await q.many('select id, name, created_at from organizations where id=$1', [t.orgId]);
    out.members = await q.many('select user_id, role, status, joined_at from organization_members where org_id=$1', [t.orgId]);
    const { audit } = await import('../core/audit');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'export.created', targetRef: `org:${t.orgId}`, detail: {} });
    return out;
  });
  c.header('content-disposition', `attachment; filename="qline-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json({ exportedAt: new Date().toISOString(), format: 'qline-export/1', data });
});

// ---- Internal scheduler tick (Neon cron trigger) -----------------------------
export const internalRoutes = new Hono();
const tick = async (c: any, key: string | undefined) => {
  if (!env.cronKey || !key || key.length !== env.cronKey.length || !timingSafeEqual(Buffer.from(key), Buffer.from(env.cronKey))) return c.json({ error: 'forbidden' }, 403);
  const r = await runScheduledWorkflows();
  return c.json({ ok: true, ...r });
};
// Neon trigger paths cannot carry a query string, so the key is a path segment.
internalRoutes.all('/tick/:key', (c) => tick(c, c.req.param('key')));
internalRoutes.all('/tick', (c) => tick(c, c.req.query('key')));
