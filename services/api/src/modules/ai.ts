import { Hono } from 'hono';
import { z } from 'zod';
import { complete, isProviderId, keyHint, listModels, PROVIDER_IDS, PROVIDERS, ProviderError, createProviderFor, type ModelInfo, type ProviderId } from '@qline/ai';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import { ApiError, notFound } from '../core/errors';
import { seal } from '../core/secrets';
import { body } from '../core/validate';
import { aad, loadKey, orgDefault } from '../agent/models';
import { mirrorPrimary, nextAlias, sealKey } from '../agent/keys';
import { checkKey, loadAgent, newVersion } from '../agent/versions';

/**
 * Bring-your-own-key AI (v1.1). Owners/admins connect any of five providers; keys are
 * validated against the provider, encrypted at rest and never returned. Each agent can be
 * assigned a provider + model, or follow the organization default.
 */
export const aiRoutes = new Hono<Env>();

const MODEL_ID = z.string().trim().min(1).max(160).regex(/^[\w.:\/@-]+$/, 'Unexpected characters in model id');

function providerParam(id: string): ProviderId {
  if (!isProviderId(id)) throw notFound('AI provider');
  return id;
}

function keyError(id: ProviderId, e: unknown): never {
  const name = PROVIDERS[id].name;
  if (e instanceof ProviderError) {
    if (e.code === 'PROVIDER_AUTH_FAILED') throw new ApiError(400, 'AI_KEY_REJECTED', `${name} rejected this key`, 'Check that you copied the whole key and that it is active.');
    if (e.code === 'PROVIDER_RATE_LIMITED') throw new ApiError(429, 'AI_RATE_LIMITED', `${name} is rate limiting this key`, e.message);
    throw new ApiError(502, 'AI_PROVIDER_ERROR', `${name} returned an error`, e.message);
  }
  throw e;
}

/** A key as the app sees it: alias, last characters, health and usage. Never the secret. */
function keyView(k: any) {
  const cooling = k.cooldown_until && new Date(k.cooldown_until) > new Date();
  return {
    id: k.id,
    alias: k.alias,
    keyHint: k.key_hint,
    primary: k.is_primary,
    enabled: k.enabled,
    state: !k.enabled ? 'off' : k.status === 'invalid' ? 'needs_attention' : cooling ? 'cooling_down' : 'ready',
    statusDetail: k.status_detail ?? null,
    cooldownUntil: cooling ? k.cooldown_until : null,
    uses: Number(k.uses),
    failures: Number(k.failures),
    rateLimited: Number(k.rate_limited),
    lastUsedAt: k.last_used_at,
  };
}

aiRoutes.get('/ai/overview', async (c) => {
  const t = need(c, 'agents.use');
  const data = await tx(t, async (q) => {
    const keys = await q.many('select provider, key_hint, status, status_detail, models, checked_at, updated_at from ai_provider_keys where org_id=$1', [t.orgId]);
    const pool = await q.many(
      `select id, provider, alias, key_hint, is_primary, enabled, status, status_detail, cooldown_until, uses, failures, rate_limited, last_used_at, created_at
         from ai_keys where org_id=$1 order by provider, is_primary desc, created_at`,
      [t.orgId],
    );
    const def = await orgDefault(q, t.orgId);
    const agents = await q.many(
      `select a.id, a.name, a.template, a.status, v.provider, v.model, v.key_id from agents a
       join agent_versions v on v.agent_id=a.id and v.version=a.current_version
       where a.status <> 'archived' order by case a.template when 'ceo' then 0 else 1 end, a.name`,
    );
    return { keys, pool, def, agents };
  });
  const byId = new Map(data.keys.map((k: any) => [k.provider, k]));
  const providers = PROVIDER_IDS.map((id) => {
    const k: any = byId.get(id);
    return {
      ...PROVIDERS[id],
      connected: !!k,
      keyHint: k?.key_hint ?? null,
      status: k?.status ?? null,
      statusDetail: k?.status_detail ?? null,
      modelCount: k ? (k.models as ModelInfo[]).length : 0,
      checkedAt: k?.checked_at ?? null,
      keys: data.pool.filter((x: any) => x.provider === id).map(keyView),
    };
  });
  const connected = (p: string | null | undefined) => !!p && byId.has(p);
  const agents = data.agents.map((a: any) => {
    const own = a.provider ? { provider: a.provider, model: a.model } : null;
    const eff = own ?? data.def;
    const key = a.key_id ? data.pool.find((x: any) => x.id === a.key_id) : null;
    return { id: a.id, name: a.name, template: a.template, status: a.status, assignment: own, effective: eff, ready: !!eff && connected(eff.provider), key: key ? { id: key.id, alias: key.alias } : null };
  });
  const ready = !!data.def && connected(data.def.provider);
  return c.json({
    status: byId.size === 0 ? 'not_configured' : ready ? 'ready' : 'no_default',
    canManage: ['owner', 'admin'].includes(t.role),
    providers,
    default: data.def,
    agents,
  });
});

aiRoutes.get('/ai/providers/:id/models', async (c) => {
  const t = need(c, 'agents.use');
  const id = providerParam(c.req.param('id'));
  const refresh = c.req.query('refresh') === '1';
  const row = await tx(t, (q) => q.one('select models from ai_provider_keys where org_id=$1 and provider=$2', [t.orgId, id]));
  if (!row) throw new ApiError(404, 'AI_PROVIDER_NOT_CONNECTED', `${PROVIDERS[id].name} is not connected`);
  if (!refresh) return c.json({ items: row.models });
  need(c, 'agents.manage');
  const key = await tx(t, (q) => loadKey(q, t.orgId, id));
  let models: ModelInfo[];
  try {
    models = await listModels(id, key!);
  } catch (e) {
    if (e instanceof ProviderError && e.code === 'PROVIDER_AUTH_FAILED') {
      await tx(t, async (q) => {
        await q.exec(`update ai_provider_keys set status='invalid', status_detail=$3, checked_at=now() where org_id=$1 and provider=$2`, [t.orgId, id, e.message.slice(0, 300)]);
        await q.exec(`update ai_keys set status='invalid', status_detail=$3, updated_at=now() where org_id=$1 and provider=$2 and is_primary`, [t.orgId, id, e.message.slice(0, 300)]);
      });
    }
    keyError(id, e);
  }
  await tx(t, (q) => q.exec(`update ai_provider_keys set models=$3, status='ok', status_detail=null, checked_at=now() where org_id=$1 and provider=$2`, [t.orgId, id, JSON.stringify(models)]));
  return c.json({ items: models });
});

aiRoutes.put('/ai/providers/:id', async (c) => {
  const t = need(c, 'ai.manage');
  const id = providerParam(c.req.param('id'));
  const input = await body(c, z.object({ apiKey: z.string().trim().min(16, 'That key looks too short').max(400).regex(/^\S+$/, 'Keys have no spaces') }));
  let models: ModelInfo[];
  try {
    models = await listModels(id, input.apiKey);
  } catch (e) {
    keyError(id, e);
  }
  if (!models.length) throw new ApiError(400, 'AI_NO_MODELS', `${PROVIDERS[id].name} accepted the key but listed no chat models`, 'Check that the account has API access enabled.');
  const sealed = seal(input.apiKey, aad(t.orgId, id));
  const hint = keyHint(input.apiKey);
  await tx(t, async (q) => {
    await q.exec(
      `insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, status, models, checked_at, created_by)
       values ($1,$2,$3,$4,'ok',$5,now(),$6)
       on conflict (org_id, provider) do update set key_ciphertext=excluded.key_ciphertext, key_hint=excluded.key_hint, status='ok', status_detail=null,
         models=excluded.models, checked_at=now(), created_by=excluded.created_by, updated_at=now()`,
      [t.orgId, id, sealed, hint, JSON.stringify(models), `user:${t.userId}`],
    );
    // M10: this replaces the primary key of the pool (or creates it). Other keys stay as they are.
    const p = await q.one<{ id: string }>('select id from ai_keys where org_id=$1 and provider=$2 and is_primary', [t.orgId, id]);
    if (p) {
      await q.exec(`update ai_keys set key_ciphertext=$2, legacy_aad=false, key_hint=$3, status='ok', status_detail=null, enabled=true, cooldown_until=null, consecutive_limits=0, updated_at=now() where id=$1`, [
        p.id,
        sealKey(t.orgId, id, p.id, input.apiKey),
        hint,
      ]);
    } else {
      const alias = await nextAlias(q, t.orgId, id);
      const k = await q.one<{ id: string }>(`insert into ai_keys (org_id, provider, alias, key_ciphertext, key_hint, is_primary, created_by) values ($1,$2,$3,'pending',$4,true,$5) returning id`, [
        t.orgId,
        id,
        alias,
        hint,
        `user:${t.userId}`,
      ]);
      await q.exec('update ai_keys set key_ciphertext=$2 where id=$1', [k!.id, sealKey(t.orgId, id, k!.id, input.apiKey)]);
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.key.saved', targetRef: `ai_provider:${id}`, detail: { provider: id, hint, models: models.length } });
  });
  return c.json({ provider: id, keyHint: hint, modelCount: models.length, models });
});

aiRoutes.delete('/ai/providers/:id', async (c) => {
  const t = need(c, 'ai.manage');
  const id = providerParam(c.req.param('id'));
  const removed = await tx(t, async (q) => {
    const r = await q.one('delete from ai_provider_keys where org_id=$1 and provider=$2 returning provider', [t.orgId, id]);
    await q.exec('delete from ai_keys where org_id=$1 and provider=$2', [t.orgId, id]);
    if (r) await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.key.removed', targetRef: `ai_provider:${id}`, detail: { provider: id } });
    return !!r;
  });
  if (!removed) throw new ApiError(404, 'AI_PROVIDER_NOT_CONNECTED', `${PROVIDERS[id].name} is not connected`);
  return c.json({ ok: true });
});

/** Sends one tiny real request so the owner can see the model answer (or the provider's real error). */
aiRoutes.post('/ai/providers/:id/test', async (c) => {
  const t = need(c, 'agents.manage');
  const id = providerParam(c.req.param('id'));
  const input = await body(c, z.object({ model: MODEL_ID }));
  const key = await tx(t, (q) => loadKey(q, t.orgId, id));
  if (!key) throw new ApiError(404, 'AI_PROVIDER_NOT_CONNECTED', `${PROVIDERS[id].name} is not connected`);
  const started = Date.now();
  try {
    const r = await complete(
      createProviderFor(id, key),
      { model: input.model, maxTokens: 1024, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] },
      AbortSignal.timeout(45_000),
    );
    return c.json({ ok: true, reply: r.text.trim().slice(0, 200), latencyMs: Date.now() - started, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError('PROVIDER_UNAVAILABLE', (e as Error).message, true);
    return c.json({ ok: false, code: pe.code, message: pe.message.slice(0, 400), latencyMs: Date.now() - started });
  }
});

const ASSIGN = z.union([z.object({ provider: z.enum(PROVIDER_IDS), model: MODEL_ID }), z.object({ provider: z.null() })]);
const ASSIGN_AGENT = z.union([
  z.object({ provider: z.enum(PROVIDER_IDS), model: MODEL_ID, keyId: z.string().uuid().nullable().optional() }),
  z.object({ provider: z.null(), keyId: z.null().optional() }),
]);

aiRoutes.put('/ai/default', async (c) => {
  const t = need(c, 'ai.manage');
  const input = await body(c, ASSIGN);
  await tx(t, async (q) => {
    if (input.provider) {
      const k = await q.one('select 1 from ai_provider_keys where org_id=$1 and provider=$2', [t.orgId, input.provider]);
      if (!k) throw new ApiError(409, 'AI_PROVIDER_NOT_CONNECTED', `Connect ${PROVIDERS[input.provider].name} first`);
    }
    const value = input.provider ? { provider: input.provider, model: (input as any).model } : null;
    await q.exec(`update organizations set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{ai}', jsonb_build_object('default', $2::jsonb), true), updated_at=now() where id=$1`, [
      t.orgId,
      JSON.stringify(value),
    ]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.default.set', targetRef: `org:${t.orgId}`, detail: { default: value } });
  });
  return c.json({ default: input.provider ? input : null });
});

/** Humans only: assigns a provider + model (and optionally one key) to an agent as a new agent version. */
aiRoutes.put('/agents/:id/model', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(c, ASSIGN_AGENT);
  const row = await tx(t, async (q) => {
    const a = await loadAgent(q, c.req.param('id'));
    if (!a || a.status === 'archived') throw notFound('Agent');
    if (input.provider) {
      const k = await q.one('select 1 from ai_provider_keys where org_id=$1 and provider=$2', [t.orgId, input.provider]);
      if (!k) throw new ApiError(409, 'AI_PROVIDER_NOT_CONNECTED', `Connect ${PROVIDERS[input.provider].name} first`);
    }
    const model = input.provider ? (input as any).model : 'default';
    // keyId: undefined keeps the current key if the provider is unchanged; null means automatic routing.
    const keyId = input.keyId !== undefined ? input.keyId : (a.provider ?? null) === (input.provider ?? null) ? (a.key_id ?? null) : null;
    await checkKey(q, t.orgId, input.provider ?? null, keyId);
    if ((a.provider ?? null) === (input.provider ?? null) && (!input.provider || a.model === model) && (a.key_id ?? null) === keyId)
      return { id: a.id, version: a.current_version, provider: a.provider, model: a.model, keyId };
    const next = await newVersion(q, t.orgId, a, { model, provider: input.provider, key_id: keyId }, `user:${t.userId}`);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.model.set', targetRef: `agent:${a.id}`, detail: { provider: input.provider, model, keyId } });
    return { id: a.id, version: next, provider: input.provider, model, keyId };
  });
  return c.json(row);
});

// ---------------------------------------------------------------------------
// M10: several keys per provider
// ---------------------------------------------------------------------------
const ALIAS = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} ._'-]+$/u, 'Use letters, numbers and spaces');
export const MAX_KEYS_PER_PROVIDER = 10;

aiRoutes.get('/ai/providers/:id/keys', async (c) => {
  const t = need(c, 'agents.use');
  const id = providerParam(c.req.param('id'));
  const items = await tx(t, (q) => q.many('select * from ai_keys where org_id=$1 and provider=$2 order by is_primary desc, created_at', [t.orgId, id]));
  return c.json({ items: items.map(keyView) });
});

/** Adds another key for a provider. It is checked against the provider first; the first one becomes the primary key. */
aiRoutes.post('/ai/providers/:id/keys', async (c) => {
  const t = need(c, 'ai.manage');
  const id = providerParam(c.req.param('id'));
  const input = await body(c, z.object({ apiKey: z.string().trim().min(16, 'That key looks too short').max(400).regex(/^\S+$/, 'Keys have no spaces'), alias: ALIAS.optional() }));
  let models: ModelInfo[];
  try {
    models = await listModels(id, input.apiKey);
  } catch (e) {
    keyError(id, e);
  }
  if (!models.length) throw new ApiError(400, 'AI_NO_MODELS', `${PROVIDERS[id].name} accepted the key but listed no chat models`, 'Check that the account has API access enabled.');
  const hint = keyHint(input.apiKey);
  const out = await tx(t, async (q) => {
    const existing = await q.many<{ id: string; alias: string; key_hint: string; key_ciphertext: string; legacy_aad: boolean; org_id: string; provider: ProviderId }>('select * from ai_keys where org_id=$1 and provider=$2', [t.orgId, id]);
    if (existing.length >= MAX_KEYS_PER_PROVIDER) throw new ApiError(409, 'AI_KEY_LIMIT', `Up to ${MAX_KEYS_PER_PROVIDER} ${PROVIDERS[id].name} keys`, 'Remove one you no longer use first.');
    if (existing.some((k) => k.key_hint === hint)) {
      const { openKey } = await import('../agent/keys');
      if (existing.some((k) => k.key_hint === hint && openKey(k) === input.apiKey)) throw new ApiError(409, 'AI_KEY_DUPLICATE', 'This key is already added');
    }
    const alias = input.alias ?? (await nextAlias(q, t.orgId, id));
    if (existing.some((k) => k.alias.toLowerCase() === alias.toLowerCase())) throw new ApiError(409, 'AI_KEY_ALIAS_TAKEN', `A key is already called "${alias}"`, 'Pick another name.');
    const primary = existing.length === 0;
    const k = await q.one<{ id: string }>(`insert into ai_keys (org_id, provider, alias, key_ciphertext, key_hint, is_primary, created_by) values ($1,$2,$3,'pending',$4,$5,$6) returning id`, [
      t.orgId,
      id,
      alias,
      hint,
      primary,
      `user:${t.userId}`,
    ]);
    await q.exec('update ai_keys set key_ciphertext=$2 where id=$1', [k!.id, sealKey(t.orgId, id, k!.id, input.apiKey)]);
    if (primary) {
      await q.exec(
        `insert into ai_provider_keys (org_id, provider, key_ciphertext, key_hint, status, models, checked_at, created_by) values ($1,$2,$3,$4,'ok',$5,now(),$6)
         on conflict (org_id, provider) do update set key_ciphertext=excluded.key_ciphertext, key_hint=excluded.key_hint, status='ok', status_detail=null, models=excluded.models, checked_at=now(), updated_at=now()`,
        [t.orgId, id, seal(input.apiKey, aad(t.orgId, id)), hint, JSON.stringify(models), `user:${t.userId}`],
      );
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.key.added', targetRef: `ai_key:${k!.id}`, detail: { provider: id, alias, hint } });
    return q.one('select * from ai_keys where id=$1', [k!.id]);
  });
  return c.json(keyView(out), 201);
});

/** Rename a key, turn it on or off, or make it the primary key. Turning it on again clears "needs attention". */
aiRoutes.patch('/ai/keys/:keyId', async (c) => {
  const t = need(c, 'ai.manage');
  const input = await body(c, z.object({ alias: ALIAS.optional(), enabled: z.boolean().optional(), primary: z.literal(true).optional() }));
  const out = await tx(t, async (q) => {
    const k = await q.one<any>('select * from ai_keys where id=$1 and org_id=$2', [c.req.param('keyId'), t.orgId]);
    if (!k) throw new ApiError(404, 'AI_KEY_NOT_FOUND', 'That key no longer exists');
    if (input.alias && input.alias.toLowerCase() !== k.alias.toLowerCase()) {
      const clash = await q.one('select 1 from ai_keys where org_id=$1 and provider=$2 and lower(alias)=lower($3) and id<>$4', [t.orgId, k.provider, input.alias, k.id]);
      if (clash) throw new ApiError(409, 'AI_KEY_ALIAS_TAKEN', `A key is already called "${input.alias}"`, 'Pick another name.');
    }
    await q.exec(
      `update ai_keys set alias=coalesce($2, alias), enabled=coalesce($3, enabled),
              status=case when $3::boolean then 'ok' else status end, status_detail=case when $3::boolean then null else status_detail end,
              cooldown_until=case when $3::boolean then null else cooldown_until end, consecutive_limits=case when $3::boolean then 0 else consecutive_limits end, updated_at=now()
        where id=$1`,
      [k.id, input.alias ?? null, input.enabled ?? null],
    );
    if (input.primary && !k.is_primary) {
      await q.exec('update ai_keys set is_primary=false where org_id=$1 and provider=$2 and is_primary', [t.orgId, k.provider]);
      await q.exec('update ai_keys set is_primary=true where id=$1', [k.id]);
      await mirrorPrimary(q, t.orgId, k.provider);
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.key.updated', targetRef: `ai_key:${k.id}`, detail: input });
    return q.one('select * from ai_keys where id=$1', [k.id]);
  });
  return c.json(keyView(out));
});

/** Removes one key. Agents pinned to it go back to automatic routing; the next key becomes primary. */
aiRoutes.delete('/ai/keys/:keyId', async (c) => {
  const t = need(c, 'ai.manage');
  const out = await tx(t, async (q) => {
    const k = await q.one<any>('delete from ai_keys where id=$1 and org_id=$2 returning *', [c.req.param('keyId'), t.orgId]);
    if (!k) throw new ApiError(404, 'AI_KEY_NOT_FOUND', 'That key no longer exists');
    const pinned = await q.many<any>(
      `select a.*, v.instructions, v.model, v.provider, v.tool_allowlist, v.key_id, v.approval_mode, v.max_tool_calls, v.daily_runs, v.max_concurrent
         from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version where v.key_id=$1`,
      [k.id],
    );
    for (const a of pinned) await newVersion(q, t.orgId, a, { key_id: null }, `user:${t.userId}`);
    let promoted: string | null = null;
    if (k.is_primary) {
      const n = await q.one<{ id: string; alias: string }>('select id, alias from ai_keys where org_id=$1 and provider=$2 order by enabled desc, (status=\'ok\') desc, created_at limit 1', [t.orgId, k.provider]);
      if (n) {
        await q.exec('update ai_keys set is_primary=true where id=$1', [n.id]);
        promoted = n.alias;
      }
      await mirrorPrimary(q, t.orgId, k.provider);
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.key.removed', targetRef: `ai_key:${k.id}`, detail: { provider: k.provider, alias: k.alias, unpinned: pinned.length, promoted } });
    return { ok: true, unpinnedAgents: pinned.length, promoted, providerDisconnected: k.is_primary && !promoted };
  });
  return c.json(out);
});
