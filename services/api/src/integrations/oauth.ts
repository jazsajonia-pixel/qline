import { createHash, randomBytes } from 'node:crypto';
import { env } from '../core/env';
import { ApiError } from '../core/errors';
import { withTenant, type Q } from '../core/db';
import { open, seal } from '../core/secrets';

/**
 * Generic OAuth 2.0 for the providers Qline integrates with. The app owner registers Qline
 * once per provider (Settings → Integration setup); after that every organization connects
 * its own account by logging in. Tokens are sealed per org and refreshed on use.
 */
export type OAuthProvider = 'google' | 'microsoft' | 'slack' | 'notion' | 'github';
export const OAUTH_PROVIDERS: OAuthProvider[] = ['google', 'microsoft', 'slack', 'notion', 'github'];
export const isOAuthProvider = (p: string): p is OAuthProvider => (OAUTH_PROVIDERS as string[]).includes(p);

export type Feature = 'gmail' | 'sheets' | 'forms' | 'calendar' | 'drive' | 'outlook' | 'ms_calendar' | 'slack' | 'notion' | 'github';

const G = 'https://www.googleapis.com/auth/';
export const FEATURE_SCOPES: Record<Feature, { provider: OAuthProvider; scopes: string[] }> = {
  gmail: { provider: 'google', scopes: [G + 'gmail.readonly', G + 'gmail.send'] },
  sheets: { provider: 'google', scopes: [G + 'drive.file'] },
  forms: { provider: 'google', scopes: [G + 'drive.file'] },
  calendar: { provider: 'google', scopes: [G + 'calendar.events'] },
  // Read any file the account can open; create and edit only files Qline made (drive.file).
  // drive.readonly is a restricted scope: fine for listed test users in Testing mode, needs Google verification to publish.
  drive: { provider: 'google', scopes: [G + 'drive.readonly', G + 'drive.file'] },
  outlook: { provider: 'microsoft', scopes: ['Mail.Read', 'Mail.Send'] },
  ms_calendar: { provider: 'microsoft', scopes: ['Calendars.ReadWrite'] },
  slack: { provider: 'slack', scopes: ['chat:write', 'chat:write.public', 'channels:read', 'channels:manage'] },
  // Notion has no scopes: the person picks which pages Qline may use on the Notion consent screen.
  notion: { provider: 'notion', scopes: [] },
  // GitHub App: permissions come from the app's settings (Issues read/write, Pull requests, Contents and Metadata read).
  github: { provider: 'github', scopes: [] },
};

const BASE_SCOPES: Record<OAuthProvider, string[]> = {
  google: ['openid', 'email', 'profile'],
  microsoft: ['offline_access', 'openid', 'email', 'User.Read'],
  slack: [],
  notion: [],
  github: [],
};

export const PROVIDER_META: Record<OAuthProvider, { name: string; console: string }> = {
  google: { name: 'Google', console: 'https://console.cloud.google.com/apis/credentials' },
  microsoft: { name: 'Microsoft', console: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps' },
  slack: { name: 'Slack', console: 'https://api.slack.com/apps' },
  notion: { name: 'Notion', console: 'https://www.notion.so/profile/integrations' },
  github: { name: 'GitHub', console: 'https://github.com/settings/apps' },
};

/** Providers whose authorize step does not take PKCE (Slack, Notion). */
const NO_PKCE = new Set<OAuthProvider>(['slack', 'notion']);
const AUTH_URL: Record<OAuthProvider, string> = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  slack: 'https://slack.com/oauth/v2/authorize',
  notion: 'https://api.notion.com/v1/oauth/authorize',
  github: 'https://github.com/login/oauth/authorize',
};

export function redirectUri(p: OAuthProvider) {
  return `${env.publicUrl.replace(/\/$/, '')}/v1/integrations/${p}/callback`;
}

// ---- Platform app credentials -------------------------------------------------
const appAad = (p: OAuthProvider) => `oauth-app:${p}`;

export async function getApp(p: OAuthProvider): Promise<{ clientId: string; clientSecret: string } | null> {
  const fromEnv = process.env[`QLINE_${p.toUpperCase()}_CLIENT_ID`];
  const secretEnv = process.env[`QLINE_${p.toUpperCase()}_CLIENT_SECRET`];
  if (fromEnv && secretEnv) return { clientId: fromEnv, clientSecret: secretEnv };
  const row = await withTenant({ orgId: null, userId: 'system:oauth' }, (q) => q.one('select client_id, secret_ciphertext from platform_oauth_apps where provider=$1', [p]));
  if (!row) return null;
  return { clientId: row.client_id, clientSecret: open(row.secret_ciphertext, appAad(p)) };
}

export async function saveApp(p: OAuthProvider, clientId: string, clientSecret: string, by: string) {
  await withTenant({ orgId: null, userId: by }, (q) =>
    q.exec(
      `insert into platform_oauth_apps (provider, client_id, secret_ciphertext, updated_by) values ($1,$2,$3,$4)
       on conflict (provider) do update set client_id=excluded.client_id, secret_ciphertext=excluded.secret_ciphertext, updated_by=excluded.updated_by, updated_at=now()`,
      [p, clientId, seal(clientSecret, appAad(p)), by],
    ),
  );
}

export async function deleteApp(p: OAuthProvider) {
  await withTenant({ orgId: null, userId: 'system:oauth' }, (q) => q.exec('delete from platform_oauth_apps where provider=$1', [p]));
}

export async function appStatus(): Promise<Record<OAuthProvider, { configured: boolean; clientIdHint: string | null }>> {
  const out: any = {};
  for (const p of OAUTH_PROVIDERS) {
    let a: { clientId: string } | null = null;
    try {
      a = await getApp(p);
    } catch {
      a = null;
    }
    out[p] = { configured: !!a, clientIdHint: a ? `…${a.clientId.slice(-12)}` : null };
  }
  return out;
}

export function isPlatformAdmin(email: string) {
  const list = (process.env.QLINE_PLATFORM_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

// ---- Authorization URL ----------------------------------------------------------
export async function buildAuthUrl(
  p: OAuthProvider,
  t: { orgId: string; workspaceId: string; userId: string },
  features: Feature[],
): Promise<string> {
  const app = await getApp(p);
  if (!app) throw new ApiError(409, 'INTEGRATION_NOT_REGISTERED', `${PROVIDER_META[p].name} isn't set up yet`, 'The app owner needs to register Qline with this provider once (Settings → Integration setup).');
  const feats = features.filter((f) => FEATURE_SCOPES[f]?.provider === p);
  const scopes = [...new Set([...BASE_SCOPES[p], ...feats.flatMap((f) => FEATURE_SCOPES[f].scopes)])];
  const state = randomBytes(24).toString('base64url');
  const verifier = NO_PKCE.has(p) ? null : randomBytes(32).toString('base64url');
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
  await withTenant({ orgId: t.orgId, userId: t.userId }, async (q) => {
    await q.exec(`delete from oauth_states where created_at < now() - interval '30 minutes'`);
    await q.exec('insert into oauth_states (state, org_id, workspace_id, user_id, provider, features, verifier) values ($1,$2,$3,$4,$5,$6,$7)', [
      state,
      t.orgId,
      t.workspaceId,
      t.userId,
      p,
      feats,
      verifier,
    ]);
  });
  const u = new URL(AUTH_URL[p]);
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', redirectUri(p));
  u.searchParams.set('state', state);
  if (p === 'slack') {
    u.searchParams.set('scope', scopes.join(','));
  } else {
    u.searchParams.set('response_type', 'code');
    if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
    if (challenge) {
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
  }
  if (p === 'notion') u.searchParams.set('owner', 'user');
  if (p === 'google') {
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'true');
  }
  if (p === 'microsoft') u.searchParams.set('prompt', 'select_account');
  return u.toString();
}

// ---- Tokens -------------------------------------------------------------------------
export interface Tokens {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number | null; // epoch ms
}

const tokenAad = (orgId: string, p: string) => `oauth:${orgId}:${p}`;

async function postForm(url: string, form: Record<string, string>) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form) });
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok && j.ok !== false, status: r.status, body: j };
}

const TOKEN_URL: Record<OAuthProvider, string> = {
  google: 'https://oauth2.googleapis.com/token',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  slack: 'https://slack.com/api/oauth.v2.access',
  notion: 'https://api.notion.com/v1/oauth/token',
  github: 'https://github.com/login/oauth/access_token',
};

/** Notion's token endpoint takes JSON with HTTP Basic client authentication. */
async function postNotion(form: Record<string, string>, app: { clientId: string; clientSecret: string }) {
  const r = await fetch(TOKEN_URL.notion, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}` },
    body: JSON.stringify(form),
  });
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok && !j.error, status: r.status, body: j };
}

/** Token request for any provider. GitHub answers errors with HTTP 200 and an `error` field. */
async function tokenRequest(p: OAuthProvider, app: { clientId: string; clientSecret: string }, form: Record<string, string>) {
  if (p === 'notion') {
    const { client_id: _a, client_secret: _b, ...rest } = form;
    return postNotion(rest, app);
  }
  const r = await postForm(TOKEN_URL[p], form);
  if (p === 'github' && r.body?.error) return { ...r, ok: false };
  return r;
}

export async function exchangeCode(p: OAuthProvider, code: string, verifier: string | null) {
  const app = await getApp(p);
  if (!app) throw new ApiError(409, 'INTEGRATION_NOT_REGISTERED', 'Integration not set up');
  const form: Record<string, string> = { client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri(p) };
  if (p !== 'slack') form.grant_type = 'authorization_code';
  if (verifier) form.code_verifier = verifier;
  const r = await tokenRequest(p, app, form);
  if (!r.ok) throw new ApiError(400, 'OAUTH_EXCHANGE_FAILED', 'Login could not be completed', r.body.error_description ?? r.body.error ?? `HTTP ${r.status}`);
  const b = r.body;
  const tokens: Tokens = { access_token: b.access_token, refresh_token: b.refresh_token ?? null, expires_at: b.expires_in ? Date.now() + Number(b.expires_in) * 1000 : null };
  const granted: string[] = p === 'slack' ? String(b.scope ?? '').split(',') : String(b.scope ?? '').split(' ');
  return { tokens, granted: granted.filter(Boolean), raw: b };
}

export async function fetchIdentity(p: OAuthProvider, tokens: Tokens, raw: any): Promise<{ email: string | null; name: string | null }> {
  if (p === 'slack') return { email: null, name: raw.team?.name ?? 'Slack workspace' };
  if (p === 'notion') return { email: raw.owner?.user?.person?.email ?? null, name: raw.workspace_name ?? raw.owner?.user?.name ?? 'Notion workspace' };
  if (p === 'github') {
    const r = await fetch('https://api.github.com/user', { signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'Qline' } });
    const j: any = await r.json().catch(() => ({}));
    return { email: j.email ?? null, name: j.login ?? j.name ?? 'GitHub account' };
  }
  const url = p === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me';
  const r = await fetch(url, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  const j: any = await r.json().catch(() => ({}));
  if (p === 'google') return { email: j.email ?? null, name: j.name ?? null };
  return { email: j.mail ?? j.userPrincipalName ?? null, name: j.displayName ?? null };
}

export function sealTokens(orgId: string, p: string, t: Tokens) {
  return seal(JSON.stringify(t), tokenAad(orgId, p));
}

export class ConnectionExpired extends Error {}

/** Returns a valid access token for a connection row, refreshing (and persisting) when needed. */
export async function accessToken(q: Q, conn: any, force = false): Promise<string> {
  const p = conn.provider as OAuthProvider;
  const t: Tokens = JSON.parse(open(conn.token_ciphertext, tokenAad(conn.org_id, p)));
  // Stripe uses a restricted API key: nothing to refresh.
  if ((conn.provider as string) === 'stripe') return t.access_token;
  if (!force && (!t.expires_at || t.expires_at > Date.now() + 60_000)) return t.access_token;
  if (!t.refresh_token) return t.access_token;
  const app = await getApp(p);
  if (!app) throw new ConnectionExpired('Integration app is no longer registered');
  const form: Record<string, string> = { client_id: app.clientId, client_secret: app.clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' };
  const r = await tokenRequest(p, app, form);
  if (!r.ok) {
    const testing = p === 'google' ? ' Google ends connections from apps in Testing mode after 7 days.' : '';
    const detail = `${PROVIDER_META[p].name} ended this connection (${r.body.error ?? r.status}).${testing} Reconnect to continue.`;
    await q.exec(`update integration_connections set status='expired', status_detail=$2, updated_at=now() where id=$1`, [conn.id, detail]);
    throw new ConnectionExpired(detail);
  }
  const next: Tokens = { access_token: r.body.access_token, refresh_token: r.body.refresh_token ?? t.refresh_token, expires_at: Date.now() + Number(r.body.expires_in ?? 3600) * 1000 };
  await q.exec('update integration_connections set token_ciphertext=$2, updated_at=now() where id=$1', [conn.id, sealTokens(conn.org_id, p, next)]);
  conn.token_ciphertext = sealTokens(conn.org_id, p, next);
  return next.access_token;
}

/** JSON fetch with a bearer token and readable errors. */
/** Provider calls never hang a worker: past this, the request is abandoned (outcome unknown for sends). */
export const PROVIDER_TIMEOUT_MS = 20_000;

export async function api(token: string, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(init.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  if (!r.ok || (j && j.ok === false)) {
    const msg = j?.error?.message ?? j?.error_description ?? (typeof j?.error === 'string' ? j.error : null) ?? `HTTP ${r.status}`;
    const e = new Error(msg) as Error & { status: number };
    e.status = r.status;
    throw e;
  }
  return j;
}

export function hasScope(conn: any, scope: string) {
  return (conn.scopes as string[]).some((s) => s === scope || s.endsWith('/' + scope) || s.toLowerCase() === scope.toLowerCase());
}
