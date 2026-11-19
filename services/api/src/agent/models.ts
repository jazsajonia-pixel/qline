import { createProviderFor, getTestProvider, isProviderId, PROVIDERS, type ChatProvider, type ProviderId } from '@qline/ai';
import type { Q } from '../core/db';
import { open } from '../core/secrets';
import { pickKey } from './keys';

export interface Assignment {
  provider: ProviderId;
  model: string;
}

export type Resolved =
  | { ok: true; provider: ChatProvider; providerId: ProviderId; model: string; source: 'agent' | 'default'; keyId: string | null; keyAlias: string | null; assignedKey: boolean }
  | { ok: false; code: 'AI_PROVIDER_NOT_CONFIGURED' | 'AI_KEY_UNAVAILABLE'; message: string };

export function aad(orgId: string, provider: string) {
  return `ai_provider_keys:${orgId}:${provider}`;
}

export async function orgDefault(q: Q, orgId: string): Promise<Assignment | null> {
  const row = await q.one<{ settings: any }>('select settings from organizations where id=$1', [orgId]);
  const d = row?.settings?.ai?.default;
  return d && isProviderId(d.provider) && typeof d.model === 'string' && d.model ? { provider: d.provider, model: d.model } : null;
}

export async function loadKey(q: Q, orgId: string, provider: ProviderId): Promise<string | null> {
  const row = await q.one<{ key_ciphertext: string }>('select key_ciphertext from ai_provider_keys where org_id=$1 and provider=$2', [orgId, provider]);
  return row ? open(row.key_ciphertext, aad(orgId, provider)) : null;
}

/**
 * Picks the model for an agent: its own assignment, else the organization's default.
 * Never falls back silently to a different provider than the one the owner chose.
 */
export async function resolveModel(
  q: Q,
  orgId: string,
  agent?: { provider?: string | null; model?: string | null; name?: string; keyId?: string | null },
  exclude: string[] = [],
): Promise<Resolved> {
  const own = agent?.provider && isProviderId(agent.provider) && agent.model ? { provider: agent.provider, model: agent.model } : null;
  const pick = own ?? (await orgDefault(q, orgId));
  if (!pick) {
    return {
      ok: false,
      code: 'AI_PROVIDER_NOT_CONFIGURED',
      message: 'No AI model is set up for this workspace yet. An owner or admin can add a provider key in Settings → AI providers.',
    };
  }
  const name = PROVIDERS[pick.provider].name;
  const notConnected = {
    ok: false as const,
    code: 'AI_PROVIDER_NOT_CONFIGURED' as const,
    message: `${agent?.name ?? 'This agent'} is set to use ${name} (${pick.model}), but no ${name} key is connected. Add one in Settings → AI providers, or pick another model.`,
  };
  // M10: a key assignment only applies to the provider it belongs to (an agent on the workspace default may switch).
  const k = await pickKey(q, orgId, pick.provider, { assignedKeyId: own ? agent?.keyId : null, exclude, agentName: agent?.name });
  let secret: string | null = null;
  let keyId: string | null = null;
  let keyAlias: string | null = null;
  if (k.ok) {
    secret = k.secret;
    keyId = k.key.id;
    keyAlias = k.key.alias;
  } else if (k.legacy && !exclude.length) {
    secret = await loadKey(q, orgId, pick.provider); // a key stored before the key pool existed
  } else if (k.code === 'AI_KEY_UNAVAILABLE') {
    return { ok: false, code: 'AI_KEY_UNAVAILABLE', message: k.message };
  }
  if (!secret) return notConnected;
  const test = getTestProvider(); // tests: real key lookup above, scripted model below
  return {
    ok: true,
    provider: test ?? createProviderFor(pick.provider, secret),
    providerId: pick.provider,
    model: pick.model,
    source: own ? 'agent' : 'default',
    keyId,
    keyAlias,
    assignedKey: k.ok && k.assigned,
  };
}
