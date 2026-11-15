import { createHash } from 'node:crypto';
import type { Q } from './db';

export interface AuditInput {
  orgId: string;
  actorKind: 'user' | 'agent' | 'workflow' | 'system';
  actorId: string;
  action: string;
  targetRef?: string | null;
  outcome?: string;
  correlationId?: string | null;
  detail?: Record<string, unknown>;
}

export const GENESIS = 'GENESIS';

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
}

export function auditHash(prev: string, e: AuditInput & { at: string }): string {
  const payload = canonical({
    orgId: e.orgId,
    actorKind: e.actorKind,
    actorId: e.actorId,
    action: e.action,
    targetRef: e.targetRef ?? null,
    outcome: e.outcome ?? 'success',
    correlationId: e.correlationId ?? null,
    detail: e.detail ?? {},
    at: e.at,
  });
  return createHash('sha256').update(`${prev}|${payload}`).digest('hex');
}

/** Append one tamper-evident audit event. Serialized per org with an advisory lock. */
export async function audit(q: Q, e: AuditInput): Promise<void> {
  await q.exec('select pg_advisory_xact_lock(hashtext($1))', [`audit:${e.orgId}`]);
  const last = await q.one<{ hash: string }>('select hash from audit_events where org_id = $1 order by id desc limit 1', [e.orgId]);
  const prev = last?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const hash = auditHash(prev, { ...e, at });
  await q.exec(
    `insert into audit_events (org_id, actor_kind, actor_id, action, target_ref, outcome, correlation_id, detail, at, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [e.orgId, e.actorKind, e.actorId, e.action, e.targetRef ?? null, e.outcome ?? 'success', e.correlationId ?? null, e.detail ?? {}, at, prev, hash],
  );
}

/** Recompute the chain. Returns the id of the first broken event, or null if intact. */
export async function verifyAuditChain(q: Q, orgId: string): Promise<{ ok: boolean; checked: number; brokenAt: number | null }> {
  const rows = await q.many(
    `select id, org_id, actor_kind, actor_id, action, target_ref, outcome, correlation_id, detail, at, prev_hash, hash
     from audit_events where org_id = $1 order by id asc`,
    [orgId],
  );
  let prev = GENESIS;
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    const expect = auditHash(prev, {
      orgId: r.org_id,
      actorKind: r.actor_kind,
      actorId: r.actor_id,
      action: r.action,
      targetRef: r.target_ref,
      outcome: r.outcome,
      correlationId: r.correlation_id,
      detail: r.detail,
      at,
    });
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, checked: rows.length, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null };
}
