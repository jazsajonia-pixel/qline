import { Hono } from 'hono';
import { z } from 'zod';
import { complete, isProviderId, keyHint, listModels, PROVIDER_IDS, PROVIDERS, ProviderError, createProviderFor, type ModelInfo, type ProviderId } from '@qline/ai';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import { ApiError, notFound } from '../core/errors';
import { seal } from '../core/secrets';
import { body } from '../core/validate';
import { aad, loadKey, orgDefault } from '../agent/models';

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

aiRoutes.get('/ai/overview', async (c) => {
  const t = need(c, 'agents.use');
  const data = await tx(t, async (q) => {
    const keys = await q.many('select provider, key_hint, status, status_detail, models, checked_at, updated_at from ai_provider_keys where org_id=$1', [t.orgId]);
    const def = await orgDefault(q, t.orgId);
    const agents = await q.many(
      `select a.id, a.name, a.template, a.status, v.provider, v.model from agents a
       join agent_versions v on v.agent_id=a.id and v.version=a.current_version
       where a.status <> 'archived' order by case a.template when 'ceo' then 0 else 1 end, a.name`,
    );
    return { keys, def, agents };
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
    };
  });
  const connected = (p: string | null | undefined) => !!p && byId.has(p);
  const agents = data.agents.map((a: any) => {
    const own = a.provider ? { provider: a.provider, model: a.model } : null;
    const eff = own ?? data.def;
    return { id: a.id, name: a.name, template: a.template, status: a.status, assignment: own, effective: eff, ready: !!eff && connected(eff.provider) };
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
      await tx(t, (q) => q.exec(`update ai_provider_keys set status='invalid', status_detail=$3, checked_at=now() where org_id=$1 and provider=$2`, [t.orgId, id, e.message.slice(0, 300)]));
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
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'ai.key.saved', targetRef: `ai_provider:${id}`, detail: { provider: id, hint, models: models.length } });
  });
  return c.json({ provider: id, keyHint: hint, modelCount: models.length, models });
});

aiRoutes.delete('/ai/providers/:id', async (c) => {
  const t = need(c, 'ai.manage');
  const id = providerParam(c.req.param('id'));
  const removed = await tx(t, async (q) => {
    const r = await q.one('delete from ai_provider_keys where org_id=$1 and provider=$2 returning provider', [t.orgId, id]);
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

/** Humans only: assigns a provider + model to an agent as a new agent version. */
aiRoutes.put('/agents/:id/model', async (c) => {
  const t = need(c, 'agents.manage');
  const input = await body(c, ASSIGN);
  const row = await tx(t, async (q) => {
    const a = await q.one(`select a.*, v.instructions, v.model, v.provider, v.tool_allowlist from agents a join agent_versions v on v.agent_id=a.id and v.version=a.current_version where a.id=$1`, [c.req.param('id')]);
    if (!a) throw notFound('Agent');
    if (input.provider) {
      const k = await q.one('select 1 from ai_provider_keys where org_id=$1 and provider=$2', [t.orgId, input.provider]);
      if (!k) throw new ApiError(409, 'AI_PROVIDER_NOT_CONNECTED', `Connect ${PROVIDERS[input.provider].name} first`);
    }
    const model = input.provider ? (input as any).model : 'default';
    if ((a.provider ?? null) === (input.provider ?? null) && (!input.provider || a.model === model)) return { id: a.id, version: a.current_version, provider: a.provider, model: a.model };
    const next = a.current_version + 1;
    await q.exec(
      `insert into agent_versions (org_id, agent_id, version, instructions, model, provider, tool_allowlist, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t.orgId, a.id, next, a.instructions, model, input.provider, a.tool_allowlist, `user:${t.userId}`],
    );
    await q.exec('update agents set current_version=$2 where id=$1', [a.id, next]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'agent.model.set', targetRef: `agent:${a.id}`, detail: { provider: input.provider, model } });
    return { id: a.id, version: next, provider: input.provider, model };
  });
  return c.json(row);
});
