import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { getAuth } from '../core/auth';
import type { Env } from '../core/context';
import { withTenant } from '../core/db';
import { ApiError } from '../core/errors';
import { open, seal } from '../core/secrets';
import { body } from '../core/validate';
import { exchangeCode, getApp, redirectUri } from '../integrations/oauth';

/**
 * "Continue with Google" for Qline accounts (mobile).
 *
 * 1. The app makes a random nonce, calls POST /v1/google-signin/start, and opens the returned URL.
 * 2. Google redirects to the already-registered integrations callback with state "si_…",
 *    which hands off to {@link finishGoogleSignIn}. It finds or creates the Qline user and a session.
 * 3. The app polls POST /v1/google-signin/finish with the nonce and receives the session token once.
 *
 * Only openid/email/profile are requested, so this works for anyone once the Google app is
 * published (these scopes don't need Google verification).
 */
export const SIGNIN_STATE_PREFIX = 'si_';
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const aad = (state: string) => `google-signin:${state}`;

export const googleSignInRoutes = new Hono<Env>();

googleSignInRoutes.post('/google-signin/start', async (c) => {
  const input = await body(c, z.object({ nonce: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/) }));
  const app = await getApp('google');
  if (!app) throw new ApiError(409, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not set up', 'Add the Google OAuth client in Settings → Integration setup first.');
  const state = SIGNIN_STATE_PREFIX + randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await withTenant({ orgId: null, userId: 'system:signin' }, async (q) => {
    await q.exec(`delete from signin_requests where created_at < now() - interval '30 minutes'`);
    await q.exec(`insert into signin_requests (state, nonce_hash, verifier) values ($1,$2,$3)`, [state, sha(input.nonce), verifier]);
  });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', redirectUri('google'));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('prompt', 'select_account');
  return c.json({ url: u.toString() });
});

googleSignInRoutes.post('/google-signin/finish', async (c) => {
  const input = await body(c, z.object({ nonce: z.string().min(32).max(128) }));
  const row = await withTenant({ orgId: null, userId: 'system:signin' }, async (q) => {
    const r = await q.one(`select * from signin_requests where nonce_hash=$1 and created_at > now() - interval '30 minutes'`, [sha(input.nonce)]);
    if (r && (r.token_ciphertext || r.error)) await q.exec(`delete from signin_requests where state=$1`, [r.state]);
    return r;
  });
  if (!row) throw new ApiError(404, 'SIGNIN_EXPIRED', 'This sign-in expired', 'Tap Continue with Google again.');
  if (row.error) throw new ApiError(400, 'GOOGLE_SIGNIN_FAILED', 'Google sign-in did not finish', row.error);
  if (!row.token_ciphertext) return c.json({ pending: true }, 202);
  return c.json({ token: open(row.token_ciphertext, aad(row.state)) });
});

/** Called from the Google OAuth callback when the state belongs to a sign-in. Returns a page title/detail. */
export async function finishGoogleSignIn(state: string, code: string | undefined, err: string | undefined): Promise<{ ok: boolean; title: string; detail: string }> {
  const row = await withTenant({ orgId: null, userId: 'system:signin' }, (q) =>
    q.one(`select * from signin_requests where state=$1 and created_at > now() - interval '30 minutes' and token_ciphertext is null and error is null`, [state]),
  );
  if (!row) return { ok: false, title: 'This sign-in link expired', detail: 'Go back to Qline and tap Continue with Google again.' };
  const failWith = async (title: string, detail: string) => {
    await withTenant({ orgId: null, userId: 'system:signin' }, (q) => q.exec(`update signin_requests set error=$2 where state=$1`, [state, detail.slice(0, 300)]));
    return { ok: false, title, detail };
  };
  if (err || !code) {
    return failWith(
      'Google sign-in was cancelled',
      err === 'access_denied' ? 'You cancelled, or this Google account is not allowed yet (while the Google app is in Testing mode only listed test users can sign in).' : (err ?? 'No code came back.'),
    );
  }
  try {
    const { tokens } = await exchangeCode('google', code, row.verifier);
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tokens.access_token}` } });
    const who: any = await r.json().catch(() => ({}));
    if (!who.sub || !who.email) return failWith('Google sign-in failed', 'Google did not share an email address.');
    if (who.email_verified === false) return failWith('Google sign-in failed', 'This Google account email is not verified.');
    const email = String(who.email).toLowerCase();
    const ctx = await getAuth().$context;
    const ia = ctx.internalAdapter;
    const found = await ia.findUserByEmail(email, { includeAccounts: true });
    let userId: string;
    if (found) {
      userId = found.user.id;
      // Google verified this address, so it is safe to link it to the existing Qline account.
      if (!found.accounts.some((a: any) => a.providerId === 'google' && a.accountId === String(who.sub))) {
        await ia.linkAccount({ userId, providerId: 'google', accountId: String(who.sub) } as any);
      }
      if (!found.user.emailVerified) await ia.updateUser(userId, { emailVerified: true });
    } else {
      const created = await ia.createOAuthUser(
        { email, name: String(who.name ?? email.split('@')[0]), emailVerified: true, image: who.picture ?? null } as any,
        { providerId: 'google', accountId: String(who.sub) } as any,
      );
      userId = created.user.id;
    }
    const session = await ia.createSession(userId);
    await withTenant({ orgId: null, userId: 'system:signin' }, (q) => q.exec(`update signin_requests set token_ciphertext=$2 where state=$1`, [state, seal(session.token, aad(state))]));
    return { ok: true, title: 'Signed in with Google', detail: `${email} is signed in. Return to Qline to continue.` };
  } catch (e) {
    return failWith('Google sign-in failed', (e as any).detail ?? (e as Error).message);
  }
}
