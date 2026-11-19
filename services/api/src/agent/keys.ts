import { PROVIDERS, type ProviderId } from '@qline/ai';
import type { Q } from '../core/db';
import { open, seal } from '../core/secrets';

/**
 * Phase 4 / M10 (docs/21 §4): several keys per provider, each with a readable alias.
 *
 * Routing policy (documented, not round-robin):
 *  1. An agent with an assigned key uses that key only. If it is disabled, invalid or cooling down, the run gets a
 *     clear error; it is never silently moved to another key.
 *  2. Otherwise the least-recently-used key that is enabled, not invalid and not cooling down is chosen. The choice
 *     is an UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED), so concurrent runs spread over keys instead of all
 *     taking the same one, and last_used_at moves forward atomically.
 *  3. A rate-limit (429) answer before any output cools that key down (60 s, doubling per consecutive limit, at most
 *     15 min) and the turn is retried once on another eligible key. No output or tool action has happened yet, so
 *     nothing is repeated. A second failure is reported to the user.
 *  4. A rejected key (401/403) is marked invalid ("needs attention") and is not tried again until a person
 *     re-enables or replaces it.
 *  5. Runs record which alias served them (agent_runs.key_id); the secret is never returned, logged or traced.
 * Multiple keys never raise a provider's own quota; they are only used as the owner configured them.
 */
export const COOLDOWN_BASE_S = 60;
export const COOLDOWN_MAX_S = 15 * 60;

export interface KeyRow {
  id: string;
  org_id: string;
  provider: ProviderId;
  alias: string;
  key_ciphertext: string;
  legacy_aad: boolean;
  key_hint: string;
  is_primary: boolean;
  enabled: boolean;
  status: 'ok' | 'invalid' | 'error';
  cooldown_until: string | null;
}

export const legacyAad = (orgId: string, provider: string) => `ai_provider_keys:${orgId}:${provider}`;
export const keyAad = (orgId: string, provider: string, id: string) => `ai_keys:${orgId}:${provider}:${id}`;

export function openKey(row: Pick<KeyRow, 'org_id' | 'provider' | 'id' | 'key_ciphertext' | 'legacy_aad'>) {
  return open(row.key_ciphertext, row.legacy_aad ? legacyAad(row.org_id, row.provider) : keyAad(row.org_id, row.provider, row.id));
}
export function sealKey(orgId: string, provider: string, id: string, secret: string) {
  return seal(secret, keyAad(orgId, provider, id));
}

const SHORT: Record<ProviderId, string> = { google: 'Gemini', openai: 'OpenAI', anthropic: 'Claude', xai: 'Grok', deepseek: 'DeepSeek' };

/** "Gemini key 3": the next free number for this provider, so aliases are distinct and readable. */
export async function nextAlias(q: Q, orgId: string, provider: ProviderId) {
  const rows = await q.many<{ alias: string }>('select alias from ai_keys where org_id=$1 and provider=$2', [orgId, provider]);
  const taken = new Set(rows.map((r) => r.alias.toLowerCase()));
  for (let n = rows.length + 1; ; n++) {
    const a = `${SHORT[provider]} key ${n}`;
    if (!taken.has(a.toLowerCase())) return a;
  }
}

export type KeyPick =
  | { ok: true; key: KeyRow; secret: string; assigned: boolean }
  | { ok: false; code: 'AI_KEY_UNAVAILABLE' | 'AI_PROVIDER_NOT_CONFIGURED'; message: string; legacy?: boolean };

const when = (iso: string) => new Date(iso).toISOString().slice(11, 16) + ' UTC';

/** Chooses a key for one model call. Runs in the caller's (short) transaction. */
export async function pickKey(q: Q, orgId: string, provider: ProviderId, opts: { assignedKeyId?: string | null; exclude?: string[]; agentName?: string } = {}): Promise<KeyPick> {
  const name = PROVIDERS[provider].name;
  if (opts.assignedKeyId) {
    const k = await q.one<KeyRow>('select * from ai_keys where id=$1 and org_id=$2', [opts.assignedKeyId, orgId]);
    const who = opts.agentName ?? 'This agent';
    if (!k || k.provider !== provider) return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: `${who} is assigned a ${name} key that no longer exists. Pick another key or automatic routing in the agent settings.` };
    if (!k.enabled) return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: `${who} uses the key "${k.alias}", which is turned off. Turn it on in Settings → AI providers, or switch the agent to automatic routing.` };
    if (k.status === 'invalid') return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: `${name} rejected the key "${k.alias}" that ${who.toLowerCase() === 'this agent' ? 'this agent' : who} uses. Replace or re-check it in Settings → AI providers.` };
    if (k.cooldown_until && new Date(k.cooldown_until) > new Date())
      return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: `The key "${k.alias}" hit ${name}'s rate limit and is paused until ${when(k.cooldown_until)}. Try again then, or switch the agent to automatic routing.` };
    await q.exec('update ai_keys set last_used_at=now(), uses=uses+1 where id=$1', [k.id]);
    return { ok: true, key: k, secret: openKey(k), assigned: true };
  }
  const exclude = opts.exclude ?? [];
  const eligible = `org_id=$1 and provider=$2 and enabled and status <> 'invalid' and (cooldown_until is null or cooldown_until <= now()) and not (id = any($3::uuid[]))`;
  let k = await q.one<KeyRow>(
    `update ai_keys set last_used_at=now(), uses=uses+1
      where id = (select id from ai_keys where ${eligible} order by last_used_at asc nulls first, created_at limit 1 for update skip locked)
      returning *`,
    [orgId, provider, exclude],
  );
  // Every eligible key is momentarily locked by a concurrent pick: take the least recently used one anyway.
  if (!k) k = await q.one<KeyRow>(`update ai_keys set last_used_at=now(), uses=uses+1 where id = (select id from ai_keys where ${eligible} order by last_used_at asc nulls first limit 1) returning *`, [orgId, provider, exclude]);
  if (k) return { ok: true, key: k, secret: openKey(k), assigned: false };
  const all = await q.many<KeyRow>('select * from ai_keys where org_id=$1 and provider=$2', [orgId, provider]);
  if (!all.length) return { ok: false, code: 'AI_PROVIDER_NOT_CONFIGURED', message: `No ${name} key is connected.`, legacy: true };
  const cooling = all.filter((x) => x.enabled && x.status !== 'invalid' && x.cooldown_until && new Date(x.cooldown_until) > new Date());
  if (cooling.length) {
    const soonest = cooling.map((x) => x.cooldown_until!).sort()[0];
    return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: `All ${name} keys hit the provider's rate limit. The first one is available again at ${when(soonest)}.` };
  }
  return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: `Every ${name} key is turned off or was rejected. Check them in Settings → AI providers.` };
}

export type KeyOutcome = 'ok' | 'rate_limited' | 'auth_failed' | 'error';

/** Records how a call went for one key: health, cooldown and counters. */
export async function reportKey(q: Q, keyId: string, outcome: KeyOutcome, detail?: string) {
  if (outcome === 'ok') {
    await q.exec(`update ai_keys set consecutive_limits=0, status=case when status='error' then 'ok' else status end, status_detail=case when status='error' then null else status_detail end where id=$1`, [keyId]);
    return;
  }
  if (outcome === 'rate_limited') {
    await q.exec(
      `update ai_keys set rate_limited=rate_limited+1, consecutive_limits=consecutive_limits+1, last_error_at=now(),
              cooldown_until = now() + make_interval(secs => least($2::int, $3::int * power(2, consecutive_limits)::int)),
              status_detail=$4, updated_at=now()
        where id=$1`,
      [keyId, COOLDOWN_MAX_S, COOLDOWN_BASE_S, (detail ?? 'Rate limited').slice(0, 300)],
    );
    return;
  }
  if (outcome === 'auth_failed') {
    await q.exec(`update ai_keys set status='invalid', failures=failures+1, last_error_at=now(), status_detail=$2, updated_at=now() where id=$1`, [keyId, (detail ?? 'Rejected by the provider').slice(0, 300)]);
    return;
  }
  await q.exec(`update ai_keys set failures=failures+1, last_error_at=now(), status_detail=$2 where id=$1`, [keyId, (detail ?? 'Provider error').slice(0, 300)]);
}

/** Keeps ai_provider_keys (read by older API versions and the voice/model-list routes) pointing at the primary key. */
export async function mirrorPrimary(q: Q, orgId: string, provider: ProviderId) {
  const p = await q.one<KeyRow>('select * from ai_keys where org_id=$1 and provider=$2 and is_primary', [orgId, provider]);
  if (!p) {
    await q.exec('delete from ai_provider_keys where org_id=$1 and provider=$2', [orgId, provider]);
    return;
  }
  const legacy = p.legacy_aad ? p.key_ciphertext : seal(openKey(p), legacyAad(orgId, provider));
  await q.exec(
    `update ai_provider_keys set key_ciphertext=$3, key_hint=$4, status=$5, status_detail=$6, updated_at=now() where org_id=$1 and provider=$2`,
    [orgId, provider, legacy, p.key_hint, p.status, null],
  );
}
