import { createHash } from 'node:crypto';
import { REUSE_POLICY } from '@qline/policy';
import { withTenant, type Q } from '../core/db';

/**
 * M2 (docs/18): a conversation-scoped ledger of read-only tool results.
 *
 * When the AI repeats a read it already did in this conversation (same tool, same arguments, same user, workspace and
 * role) and the result is still valid, Qline returns the stored result instead of running the tool again.
 * Valid means all of:
 * - not past its expiry (`REUSE_POLICY[tool].ttlSec`, at most 30 minutes);
 * - no committed change since the read to any Qline table it depends on (exact: `data_changes` rows are checked
 *   against the snapshot the read ran under, so every write path counts: the app, agents, imports, syncs);
 * - no Qline write since the read to the same connected app (e.g. a `drive.update` invalidates `drive.read`);
 * - the user did not ask for fresh data in this message.
 * Changes made directly in a connected app (a new email arriving) are only covered by the short expiries.
 */

export interface LedgerScope {
  orgId: string;
  workspaceId: string;
  conversationId: string;
  userId: string;
  role: string;
}

export interface LedgerEntry {
  id: string;
  tool: string;
  summary: string;
  data: unknown;
  refs: { type: string; id: string; title?: string }[];
  created_at: string;
  source_tool_call_id: string | null;
  duration_ms: number;
  provider_reads: number;
}

/** Arguments in a stable form (object keys sorted), so `{a,b}` and `{b,a}` are the same call. */
export function stableArgs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableArgs).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableArgs((v as any)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
export const argsHash = (args: unknown) => createHash('sha256').update(stableArgs(args)).digest('hex');

export const reusable = (tool: string) => tool in REUSE_POLICY;

/** The snapshot (and time) the current transaction's next read runs under. Taken just before the tool reads. */
export async function currentSnapshot(q: Q): Promise<{ snap: string; at: string }> {
  return (await q.one<{ snap: string; at: string }>('select pg_current_snapshot()::text as snap, clock_timestamp() as at'))!;
}

/** The tool's own transaction id, if it wrote anything (e.g. `last_used_at`): its own changes must not count. */
export async function ownXid(q: Q): Promise<string | null> {
  return (await q.one<{ x: string | null }>('select pg_current_xact_id_if_assigned()::text as x'))?.x ?? null;
}

/** A still-valid stored result for this exact call, or null. Stale entries are marked invalidated. */
export async function findReusable(q: Q, s: LedgerScope, tool: string, args: unknown): Promise<LedgerEntry | null> {
  const policy = REUSE_POLICY[tool];
  if (!policy) return null;
  const e = await q.one<LedgerEntry & { snap: string; own_xid: string | null }>(
    `select id, tool, summary, data, refs, created_at, source_tool_call_id, duration_ms, provider_reads, snap::text as snap, own_xid::text as own_xid
       from conversation_context
      where conversation_id=$1 and user_id=$2 and workspace_id=$3 and role=$4 and tool=$5 and args_hash=$6
        and invalidated_at is null and expires_at > now()`,
    [s.conversationId, s.userId, s.workspaceId, s.role, tool, argsHash(args)],
  );
  if (!e) return null;
  // Any change to a table it depends on that the read could not see (committed later, or in progress then).
  const changed = await q.one(
    `select 1 from data_changes where org_id=$1 and tbl = any($2::text[]) and changed_at > $3::timestamptz - interval '1 hour'
        and not pg_visible_in_snapshot(xid, $4::pg_snapshot) and ($5::xid8 is null or xid <> $5::xid8) limit 1`,
    [s.orgId, policy.tables, e.created_at, e.snap, e.own_xid],
  );
  const wrote =
    !changed && policy.writes?.length
      ? await q.one(
          `select 1 from tool_calls where org_id=$1 and risk <> 'L0' and status in ('executing','succeeded','unknown')
              and tool like any($2::text[]) and coalesce(finished_at, created_at) >= $3::timestamptz limit 1`,
          [s.orgId, policy.writes.map((p) => `${p}%`), e.created_at],
        )
      : null;
  if (changed || wrote) {
    await q.exec('update conversation_context set invalidated_at=now() where id=$1', [e.id]);
    return null;
  }
  await q.exec('update conversation_context set hits=hits+1, last_hit_at=now() where id=$1', [e.id]);
  return e;
}

/** Stores a successful read so the same call can be answered from it while valid. */
export async function remember(
  s: LedgerScope,
  x: { tool: string; args: unknown; summary: string; data: unknown; refs: unknown[]; toolCallId: string; snapshot: { snap: string; at: string }; ownXid: string | null; durationMs: number; providerReads: number },
): Promise<void> {
  const policy = REUSE_POLICY[x.tool];
  if (!policy) return;
  const data = x.data === undefined ? null : JSON.stringify(x.data);
  await withTenant({ orgId: s.orgId, userId: s.userId, runKind: 'interactive' }, (q) =>
    q.exec(
      `insert into conversation_context (org_id, workspace_id, conversation_id, user_id, role, tool, args_hash, args, summary, data, refs,
                                         source_tool_call_id, snap, own_xid, duration_ms, provider_reads, result_chars, created_at, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::pg_snapshot,$14::xid8,$15,$16,$17,$18::timestamptz, $18::timestamptz + make_interval(secs => $19))
       on conflict (org_id, conversation_id, user_id, tool, args_hash) do update set
         role=excluded.role, workspace_id=excluded.workspace_id, summary=excluded.summary, data=excluded.data, refs=excluded.refs,
         source_tool_call_id=excluded.source_tool_call_id, snap=excluded.snap, own_xid=excluded.own_xid, duration_ms=excluded.duration_ms,
         provider_reads=excluded.provider_reads, result_chars=excluded.result_chars, hits=0, last_hit_at=null,
         created_at=excluded.created_at, expires_at=excluded.expires_at, invalidated_at=null`,
      [
        s.orgId,
        s.workspaceId,
        s.conversationId,
        s.userId,
        s.role,
        x.tool,
        argsHash(x.args),
        JSON.stringify(x.args ?? {}),
        x.summary.slice(0, 500),
        data,
        JSON.stringify(x.refs ?? []),
        x.toolCallId,
        x.snapshot.snap,
        x.ownXid,
        Math.round(x.durationMs),
        x.providerReads,
        data?.length ?? 0,
        x.snapshot.at,
        policy.ttlSec,
      ],
    ),
  );
}

/**
 * Short list of what this conversation already looked up, for the system prompt, so the model knows what it has
 * and repeats identical calls (served from the ledger) instead of new, broader ones. Summaries only, never data.
 */
export async function ledgerDigest(q: Q, s: LedgerScope, limit = 10): Promise<string[]> {
  const rows = await q.many<{ tool: string; args: unknown; summary: string; age: number }>(
    `select tool, args, summary, extract(epoch from now() - created_at)::int as age from conversation_context
      where conversation_id=$1 and user_id=$2 and workspace_id=$3 and invalidated_at is null and expires_at > now()
      order by created_at desc limit $4`,
    [s.conversationId, s.userId, s.workspaceId, limit],
  );
  return rows.map((r) => `- ${r.tool} ${stableArgs(r.args).slice(0, 200)} · ${Math.max(1, Math.round(r.age / 60))} min ago · ${r.summary.slice(0, 160)}`);
}

/** What reuse saved in a conversation (measured, not estimated). */
export async function ledgerStats(q: Q, conversationId: string, userId: string) {
  const items = await q.many(
    `select tool, args, summary, hits, duration_ms, provider_reads, result_chars, created_at, expires_at, invalidated_at,
            (invalidated_at is null and expires_at > now()) as live
       from conversation_context where conversation_id=$1 and user_id=$2 order by created_at desc limit 50`,
    [conversationId, userId],
  );
  const reused = await q.one<{ n: number }>(`select count(*)::int as n from tool_calls tc join agent_runs r on r.id = tc.run_id where r.conversation_id=$1 and tc.reused_context_id is not null`, [conversationId]);
  const sum = (f: (x: any) => number) => items.reduce((a, x) => a + f(x), 0);
  return {
    items,
    savings: {
      reusedCalls: reused?.n ?? 0,
      providerRequestsAvoided: sum((x) => x.hits * x.provider_reads),
      toolMsAvoided: sum((x) => x.hits * x.duration_ms),
      resultCharsReused: sum((x) => x.hits * x.result_chars),
    },
  };
}

/** Scheduler tick (all tenants): drop expired entries and old change-log rows. */
export async function purgeLedger(): Promise<number> {
  const r = await withTenant({ orgId: null, userId: 'system:ledger' }, (q) => q.one<{ n: number }>('select qline_purge_context() as n'));
  return Number(r?.n ?? 0);
}
