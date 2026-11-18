import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import { withTenant } from '../core/db';
import { ApiError, badRequest, notFound } from '../core/errors';
import { body } from '../core/validate';
import {
  accessToken,
  appStatus,
  buildAuthUrl,
  deleteApp,
  exchangeCode,
  FEATURE_SCOPES,
  fetchIdentity,
  getApp,
  hasScope,
  isOAuthProvider,
  isPlatformAdmin,
  OAUTH_PROVIDERS,
  PROVIDER_META,
  redirectUri,
  saveApp,
  sealTokens,
  TokenRefreshUnavailable,
  type Feature,
  type OAuthProvider,
} from '../integrations/oauth';
import { classify, loadRules, rulesSchema, saveRules, syncConnection } from '../integrations/leads';
import { formCreate, sheetCreate, slackChannels, slackPost, slackRevoke, upcomingEvents } from '../integrations/services';
import { open } from '../core/secrets';
import { STRIPE_KEY, stripeVerify } from '../integrations/connectors';
import { finishGoogleSignIn, SIGNIN_STATE_PREFIX } from './google-signin';
import { complete } from '@qline/ai';
import { resolveModel } from '../agent/models';

const FEATURES: Record<OAuthProvider, { id: Feature; name: string; detail: string }[]> = {
  google: [
    { id: 'gmail', name: 'Gmail lead inbox', detail: 'Reads new inbox emails, finds leads and rates urgency. Sends replies only after you approve them.' },
    { id: 'sheets', name: 'Google Sheets', detail: 'A “Qline Leads” sheet that stays in sync: new leads go in, rows you add come back as leads.' },
    { id: 'forms', name: 'Google Forms', detail: 'A ready-made lead form. Every response becomes a lead automatically.' },
    { id: 'calendar', name: 'Google Calendar', detail: 'See upcoming events and let workflows book follow-ups.' },
    { id: 'drive', name: 'Google Drive', detail: 'The AI can search and read your Drive files, and create or update files it made (with your approval).' },
  ],
  microsoft: [
    { id: 'outlook', name: 'Outlook lead inbox', detail: 'Reads new Outlook / Microsoft 365 inbox emails, finds leads and rates urgency.' },
    { id: 'ms_calendar', name: 'Outlook Calendar', detail: 'See upcoming events and let workflows book follow-ups.' },
  ],
  slack: [{ id: 'slack', name: 'Slack alerts', detail: 'Posts urgent leads, approvals and workflow messages to a channel.' }],
  notion: [{ id: 'notion', name: 'Notion pages', detail: 'The AI can search and read the pages you share with Qline, and create or add to pages with your approval.' }],
  github: [{ id: 'github', name: 'GitHub issues', detail: 'The AI can read repositories, issues and pull requests where the Qline app is installed, and open issues or comment with your approval. It never changes code.' }],
};

/** Key-based providers (no OAuth app): the organization pastes a restricted key. */
const STRIPE_FEATURES = [{ id: 'stripe', name: 'Stripe payments', detail: 'The AI can summarize payments, invoices and subscriptions. It can add customers and prepare draft invoices with your approval; it never sends, charges or refunds.' }];

const PLANNED = [
  { id: 'file_import', name: 'File import', category: 'Data', status: 'available', detail: 'CSV, XLSX, JSON, TXT, MD, PDF and DOCX up to 10 MB. Use Import.' },
  { id: 'meta', name: 'Meta (Facebook / Instagram)', category: 'Marketing', status: 'planned', detail: 'Needs Meta app review. Planned.' },
];

function providerParam(p: string): OAuthProvider {
  if (!isOAuthProvider(p)) throw notFound('Integration');
  return p;
}

const publicConn = (c: any) =>
  c && {
    id: c.id,
    provider: c.provider,
    accountEmail: c.account_email,
    accountName: c.account_name,
    scopes: c.scopes,
    status: c.status,
    statusDetail: c.status_detail,
    settings: c.settings,
    lastSyncAt: c.last_sync_at,
    connectedAt: c.created_at,
    features: c.provider === 'stripe' ? ['stripe'] : FEATURES[c.provider as OAuthProvider].filter((f) => FEATURE_SCOPES[f.id].scopes.every((s) => hasScope(c, s))).map((f) => f.id),
  };

// ---------------------------------------------------------------------------------------------
// Public OAuth callback (the provider redirects the browser here)
// ---------------------------------------------------------------------------------------------
export const oauthPublicRoutes = new Hono<Env>();

function page(ok: boolean, title: string, detail: string, provider: string, back?: string) {
  const link = back ?? `qline://integrations?provider=${encodeURIComponent(provider)}&ok=${ok ? 1 : 0}`;
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07100F;color:#ECF3EF;font:16px/1.5 system-ui,sans-serif}
main{max-width:360px;padding:32px 24px;text-align:center}.dot{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;background:${ok ? '#F5C451' : '#FF6F80'};box-shadow:0 0 48px ${ok ? '#F5C45166' : '#FF6F8055'}}
h1{font-size:22px;margin:0 0 8px}p{color:#AABBB5;margin:0 0 24px}a{display:inline-block;padding:14px 22px;border-radius:14px;background:#F5C451;color:#1C1500;font-weight:600;text-decoration:none}</style></head>
<body><main><div class="dot"></div><h1>${esc(title)}</h1><p>${esc(detail)}</p><a href="${link}">Return to Qline</a></main>
<script>setTimeout(function(){location.href=${JSON.stringify(link)}},600)</script></body></html>`;
}

oauthPublicRoutes.get('/integrations/:provider/callback', async (c) => {
  const p = c.req.param('provider');
  if (!isOAuthProvider(p)) return c.html(page(false, 'Unknown integration', 'This link is not valid.', p), 404);
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code');
  const err = c.req.query('error');
  if (p === 'google' && state.startsWith(SIGNIN_STATE_PREFIX)) {
    const r = await finishGoogleSignIn(state, code, err);
    return c.html(page(r.ok, r.title, r.detail, p, `qline://auth?ok=${r.ok ? 1 : 0}`), r.ok ? 200 : 400);
  }
  const st = state
    ? await withTenant({ orgId: null, userId: 'system:oauth' }, async (q) => {
        const r = await q.one(`delete from oauth_states where state=$1 and provider=$2 returning *, created_at > now() - interval '30 minutes' as fresh`, [state, p]);
        return r?.fresh ? r : null;
      })
    : null;
  const name = PROVIDER_META[p].name;
  if (err) return c.html(page(false, `${name} was not connected`, err === 'access_denied' ? 'You cancelled, or this account is not allowed to use Qline yet (Google Testing mode only allows listed test users).' : err, p), 400);
  if (!st || !code) return c.html(page(false, 'This login link expired', 'Go back to Qline and tap Connect again.', p), 400);
  try {
    const { tokens, granted, raw } = await exchangeCode(p, code, st.verifier);
    const who = await fetchIdentity(p, tokens, raw);
    await withTenant({ orgId: st.org_id, userId: st.user_id }, async (q) => {
      const prev = await q.one('select * from integration_connections where provider=$1', [p]);
      let merged = tokens;
      if (prev && !tokens.refresh_token) {
        try {
          const old = JSON.parse(open(prev.token_ciphertext, `oauth:${st.org_id}:${p}`));
          merged = { ...tokens, refresh_token: old.refresh_token };
        } catch {
          /* ignore */
        }
      }
      const sameAccount = prev && prev.account_email === who.email && prev.account_name === who.name;
      const scopes = [...new Set([...(sameAccount && p === 'google' ? prev.scopes : []), ...granted])];
      await q.exec(
        `insert into integration_connections (org_id, workspace_id, provider, account_email, account_name, scopes, token_ciphertext, status, connected_by)
         values ($1,$2,$3,$4,$5,$6,$7,'ok',$8)
         on conflict (org_id, provider) do update set account_email=excluded.account_email, account_name=excluded.account_name, scopes=excluded.scopes,
           token_ciphertext=excluded.token_ciphertext, status='ok', status_detail=null, connected_by=excluded.connected_by, updated_at=now(),
           cursor = case when $9 then integration_connections.cursor else '{}'::jsonb end,
           settings = case when $9 then integration_connections.settings else '{}'::jsonb end`,
        [st.org_id, st.workspace_id, p, who.email, who.name, scopes, sealTokens(st.org_id, p, merged), st.user_id, !!sameAccount],
      );
      await audit(q, { orgId: st.org_id, actorKind: 'user', actorId: st.user_id, action: 'integration.connected', targetRef: `integration:${p}`, detail: { account: who.email ?? who.name, scopes } });
    });
    return c.html(page(true, `${name} connected`, `${who.email ?? who.name ?? 'Your account'} is now connected to Qline.`, p));
  } catch (e) {
    return c.html(page(false, `${name} was not connected`, (e as any).detail ?? (e as Error).message, p), 400);
  }
});

// ---------------------------------------------------------------------------------------------
// Tenant routes
// ---------------------------------------------------------------------------------------------
export const integrationRoutes = new Hono<Env>();

integrationRoutes.get('/integrations', async (c) => {
  const t = c.get('tenant');
  const [apps, conns] = await Promise.all([appStatus(), tx(t, (q) => q.many('select * from integration_connections'))]);
  const byP = new Map(conns.map((x: any) => [x.provider, x]));
  return c.json({
    providers: [
      ...OAUTH_PROVIDERS.map((p) => ({ id: p, name: PROVIDER_META[p].name, auth: 'oauth', registered: apps[p].configured, connection: publicConn(byP.get(p)) ?? null, features: FEATURES[p] })),
      { id: 'stripe', name: 'Stripe', auth: 'key', registered: true, connection: publicConn(byP.get('stripe')) ?? null, features: STRIPE_FEATURES },
    ],
    other: PLANNED,
    canSetup: isPlatformAdmin(t.email),
    // legacy shape for v1.1 clients
    items: PLANNED.map((x) => ({ ...x, status: x.status === 'available' ? 'available' : 'not_configured' })),
  });
});

integrationRoutes.post('/integrations/:provider/connect', async (c) => {
  const t = need(c, 'integrations.manage');
  const p = providerParam(c.req.param('provider'));
  const input = await body(c, z.object({ features: z.array(z.string()).max(10).optional() }).default({}));
  const all = FEATURES[p].map((f) => f.id);
  const features = (input.features?.length ? input.features.filter((f) => (all as string[]).includes(f)) : all) as Feature[];
  return c.json({ url: await buildAuthUrl(p, t, features) });
});

// Stripe: the owner creates a restricted key in the Stripe Dashboard and pastes it here.
integrationRoutes.post('/integrations/stripe/key', async (c) => {
  const t = need(c, 'integrations.manage');
  const input = await body(c, z.object({ key: z.string().trim().min(10).max(300) }));
  if (/^sk_(live|test)_/.test(input.key)) throw new ApiError(400, 'STRIPE_SECRET_KEY', 'Use a restricted key', 'Full secret keys are not accepted. In Stripe, create a restricted key (rk_…) with only the permissions listed in Qline.');
  if (!STRIPE_KEY.test(input.key)) throw badRequest('That is not a Stripe restricted key (it starts with rk_live_ or rk_test_).');
  const who = await stripeVerify(input.key).catch((e) => {
    throw new ApiError(400, 'STRIPE_KEY_REJECTED', 'Stripe did not accept this key', (e as Error).message);
  });
  const mode = input.key.startsWith('rk_test_') ? 'test' : 'live';
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `insert into integration_connections (org_id, workspace_id, provider, account_email, account_name, scopes, token_ciphertext, status, connected_by, settings)
       values ($1,$2,'stripe',$3,$4,$5,$6,'ok',$7,$8)
       on conflict (org_id, provider) do update set account_email=excluded.account_email, account_name=excluded.account_name, scopes=excluded.scopes,
         token_ciphertext=excluded.token_ciphertext, status='ok', status_detail=null, connected_by=excluded.connected_by, settings=excluded.settings, updated_at=now()
       returning *`,
      [t.orgId, t.workspaceId, who.email, who.name, ['restricted_key'], sealTokens(t.orgId, 'stripe', { access_token: input.key }), t.userId, JSON.stringify({ mode })],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'integration.connected', targetRef: 'integration:stripe', detail: { account: who.name, mode } });
    return r;
  });
  return c.json(publicConn(row), 201);
});

integrationRoutes.delete('/integrations/:provider', async (c) => {
  const t = need(c, 'integrations.manage');
  const raw = c.req.param('provider');
  const p = (raw === 'stripe' ? 'stripe' : providerParam(raw)) as OAuthProvider;
  const conn = await tx(t, (q) => q.one('select * from integration_connections where provider=$1', [p]));
  if (!conn) throw notFound('Connection');
  if (p === 'google' || p === 'slack') {
    try {
      const tok = JSON.parse(open(conn.token_ciphertext, `oauth:${t.orgId}:${p}`));
      if (p === 'google') await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok.refresh_token ?? tok.access_token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
      else await slackRevoke(tok.access_token);
    } catch {
      /* best effort */
    }
  }
  if (p === 'github') {
    // Revoking a GitHub App user token needs the app's client credentials (best effort).
    try {
      const tok = JSON.parse(open(conn.token_ciphertext, `oauth:${t.orgId}:${p}`));
      const app = await getApp('github');
      if (app) {
        await fetch(`https://api.github.com/applications/${encodeURIComponent(app.clientId)}/token`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`, accept: 'application/vnd.github+json', 'user-agent': 'Qline', 'content-type': 'application/json' },
          body: JSON.stringify({ access_token: tok.access_token }),
        });
      }
    } catch {
      /* best effort */
    }
  }
  await tx(t, async (q) => {
    await q.exec('delete from integration_connections where id=$1', [conn.id]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'integration.disconnected', targetRef: `integration:${p}` });
  });
  return c.json({ ok: true });
});

const settingsInput = z.object({
  gmail: z.object({ enabled: z.boolean() }).optional(),
  outlook: z.object({ enabled: z.boolean() }).optional(),
  channel: z.object({ id: z.string().max(40), name: z.string().max(120) }).nullable().optional(),
});
integrationRoutes.patch('/integrations/:provider/settings', async (c) => {
  const t = need(c, 'integrations.manage');
  const p = providerParam(c.req.param('provider'));
  const input = await body(c, settingsInput);
  const row = await tx(t, (q) => q.one(`update integration_connections set settings = settings || $2::jsonb, updated_at=now() where provider=$1 returning *`, [p, JSON.stringify(input)]));
  if (!row) throw notFound('Connection');
  return c.json(publicConn(row));
});

async function connOrThrow(t: any, p: OAuthProvider) {
  const conn = await tx(t, (q) => q.one('select * from integration_connections where provider=$1', [p]));
  if (!conn) throw new ApiError(409, 'NOT_CONNECTED', `${PROVIDER_META[p].name} is not connected`, 'Connect it first in Integrations.');
  if (conn.status !== 'ok') throw new ApiError(409, 'RECONNECT_REQUIRED', `Reconnect ${PROVIDER_META[p].name}`, conn.status_detail ?? 'The connection expired.');
  return conn;
}
const tokenFor = (t: any, conn: any) => tx(t, (q) => accessToken(q, conn)).catch((e) => {
  if (e instanceof TokenRefreshUnavailable) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', `${PROVIDER_META[conn.provider as OAuthProvider].name} is not answering`, (e as Error).message);
  throw new ApiError(409, 'RECONNECT_REQUIRED', 'Reconnect needed', (e as Error).message);
});
const upstream = (e: unknown, what: string): never => {
  if (e instanceof ApiError) throw e;
  throw new ApiError(502, 'INTEGRATION_ERROR', `${what} failed`, (e as Error).message);
};

integrationRoutes.post('/integrations/:provider/sync', async (c) => {
  const t = need(c, 'integrations.manage');
  const p = providerParam(c.req.param('provider'));
  if (p !== 'google' && p !== 'microsoft') throw new ApiError(400, 'NOT_SYNCABLE', `${PROVIDER_META[p].name} does not sync`, 'Only Google and Microsoft inboxes sync leads.');
  const conn = await connOrThrow(t, p);
  const r = await syncConnection({ orgId: t.orgId, workspaceId: t.workspaceId, userId: conn.connected_by }, conn.id);
  return c.json(r);
});

integrationRoutes.post('/integrations/google/sheet', async (c) => {
  const t = need(c, 'integrations.manage');
  const conn = await connOrThrow(t, 'google');
  if (!hasScope(conn, 'drive.file')) throw new ApiError(409, 'SCOPE_MISSING', 'Allow Google Sheets first', 'Reconnect Google and tick Google Sheets.');
  const token = await tokenFor(t, conn);
  const org = await tx(t, (q) => q.one('select name from organizations where id=$1', [t.orgId]));
  const sheet = await sheetCreate(token, `Qline Leads — ${org?.name ?? 'Business'}`).catch((e) => upstream(e, 'Creating the sheet'));
  await tx(t, (q) => q.exec(`update integration_connections set settings = settings || $2::jsonb, cursor = cursor - 'sheet' where id=$1`, [conn.id, JSON.stringify({ sheet })]));
  const r = await syncConnection({ orgId: t.orgId, workspaceId: t.workspaceId, userId: conn.connected_by }, conn.id);
  return c.json({ sheet, sync: r }, 201);
});

integrationRoutes.post('/integrations/google/form', async (c) => {
  const t = need(c, 'integrations.manage');
  const input = await body(c, z.object({ title: z.string().trim().min(1).max(120).optional(), description: z.string().max(500).optional() }).default({}));
  const conn = await connOrThrow(t, 'google');
  if (!hasScope(conn, 'drive.file')) throw new ApiError(409, 'SCOPE_MISSING', 'Allow Google Forms first', 'Reconnect Google and tick Google Forms.');
  const token = await tokenFor(t, conn);
  const org = await tx(t, (q) => q.one('select name from organizations where id=$1', [t.orgId]));
  const form = await formCreate(token, input.title ?? `Contact ${org?.name ?? 'us'}`, input.description ?? 'Tell us what you need and we will get back to you quickly.').catch((e) => upstream(e, 'Creating the form'));
  await tx(t, (q) => q.exec(`update integration_connections set settings = settings || $2::jsonb, cursor = cursor - 'formAfter' where id=$1`, [conn.id, JSON.stringify({ form })]));
  await tx(t, (q) => audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: form.accepting ? 'form.published' : 'form.publish_unverified', targetRef: `form:${form.id}`, correlationId: t.correlationId, detail: { error: form.publishError ?? null } }));
  // 201 either way (the form exists); `accepting:false` + `publishError` tell the app it is not live yet.
  return c.json({ form }, 201);
});

integrationRoutes.get('/integrations/slack/channels', async (c) => {
  const t = need(c, 'integrations.manage');
  const conn = await connOrThrow(t, 'slack');
  const token = await tokenFor(t, conn);
  return c.json({ items: await slackChannels(token).catch((e) => upstream(e, 'Listing channels')) });
});

integrationRoutes.post('/integrations/slack/test', async (c) => {
  const t = need(c, 'integrations.manage');
  const conn = await connOrThrow(t, 'slack');
  const ch = conn.settings?.channel?.id;
  if (!ch) throw new ApiError(400, 'CHANNEL_REQUIRED', 'Pick a channel first');
  const token = await tokenFor(t, conn);
  await slackPost(token, ch, ':wave: Qline is connected. Urgent leads and approvals will show up here.').catch((e) => upstream(e, 'Posting to Slack'));
  return c.json({ ok: true });
});

integrationRoutes.get('/calendar/upcoming', async (c) => {
  const t = need(c, 'tasks.read');
  const conns = await tx(t, (q) => q.many(`select * from integration_connections where provider in ('google','microsoft') and status='ok'`));
  const items: any[] = [];
  const errors: string[] = [];
  for (const conn of conns) {
    if (!hasScope(conn, conn.provider === 'google' ? 'calendar.events' : 'Calendars.ReadWrite')) continue;
    try {
      items.push(...(await upcomingEvents(conn.provider, await tokenFor(t, conn))));
    } catch (e) {
      errors.push(`${PROVIDER_META[conn.provider as OAuthProvider].name}: ${(e as Error).message}`);
    }
  }
  items.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return c.json({ items, errors, connected: conns.length > 0 });
});

// ---- Leads ------------------------------------------------------------------------------------
integrationRoutes.get('/leads/inbox', async (c) => {
  const t = need(c, 'contacts.read');
  const f = c.req.query('filter') ?? 'all';
  const items = await tx(t, (q) =>
    q.many(
      `select i.*, c.name as contact_name from lead_inbox i left join contacts c on c.id=i.contact_id
       where ($1='all' or ($1='lead' and i.is_lead) or ($1='ignored' and not i.is_lead) or ($1='urgent' and i.urgency in ('high','urgent') and i.is_lead))
       order by coalesce(i.received_at, i.created_at) desc limit 100`,
      [f],
    ),
  );
  const counts = await tx(t, (q) =>
    q.one(`select (count(*) filter (where is_lead))::int as leads, (count(*) filter (where is_lead and urgency in ('high','urgent')))::int as urgent, (count(*) filter (where not is_lead))::int as ignored,
             (count(*) filter (where is_lead and created_at > now() - interval '24 hours'))::int as today from lead_inbox`),
  );
  return c.json({ items, counts });
});

integrationRoutes.post('/leads/inbox/:id/mark', async (c) => {
  const t = need(c, 'contacts.write');
  const input = await body(c, z.object({ lead: z.boolean(), ignoreSender: z.boolean().optional(), urgency: z.enum(['low', 'normal', 'high', 'urgent']).optional() }));
  const row = await tx(t, async (q) => {
    const it = await q.one('select * from lead_inbox where id=$1', [c.req.param('id')]);
    if (!it) throw notFound('Inbox item');
    let contactId = it.contact_id;
    if (input.lead && !contactId) {
      const existing = it.from_email ? await q.one('select id from contacts where lower(email)=lower($1) and deleted_at is null', [it.from_email]) : null;
      contactId =
        existing?.id ??
        (
          await q.one(
            `insert into contacts (org_id, workspace_id, name, email, stage, notes, source_kind, source_ref, created_by, urgency, lead_summary, last_inbound_at)
             values ($1,$2,$3,$4,'lead',$5,$6,$7,$8,$9,$10,now()) returning id`,
            [t.orgId, t.workspaceId, it.from_name ?? it.from_email ?? 'Unknown', it.from_email, it.subject, it.source, it.external_id, `user:${t.userId}`, input.urgency ?? it.urgency ?? 'normal', it.summary ?? it.subject],
          )
        ).id;
    }
    if (input.ignoreSender && it.from_email) {
      const rules = await loadRules(q, t.orgId);
      const dom = it.from_email.split('@')[1];
      if (dom && !rules.ignoreDomains.includes(dom)) await saveRules(q, t.orgId, { ...rules, ignoreDomains: [...rules.ignoreDomains, dom] });
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: input.lead ? 'lead.marked' : 'lead.dismissed', targetRef: `lead_inbox:${it.id}` });
    return q.one(`update lead_inbox set is_lead=$2, status=$3, contact_id=$4, urgency=coalesce($5, urgency), reason=$6 where id=$1 returning *`, [
      it.id,
      input.lead,
      input.lead ? 'lead' : 'ignored',
      input.lead ? contactId : it.contact_id,
      input.urgency ?? null,
      input.lead ? 'Marked as a lead by a person' : 'Marked as not a lead by a person',
    ]);
  });
  return c.json(row);
});

integrationRoutes.get('/leads/rules', async (c) => {
  const t = need(c, 'contacts.read');
  return c.json(await tx(t, (q) => loadRules(q, t.orgId)));
});

integrationRoutes.put('/leads/rules', async (c) => {
  const t = need(c, 'integrations.manage');
  const rules = await body(c, rulesSchema);
  await tx(t, async (q) => {
    await saveRules(q, t.orgId, rules);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'leads.rules.updated', targetRef: `org:${t.orgId}` });
  });
  return c.json(rules);
});

integrationRoutes.post('/leads/rules/test', async (c) => {
  const t = need(c, 'contacts.read');
  const input = await body(c, z.object({ from: z.string().max(320).default(''), subject: z.string().max(300).default(''), text: z.string().max(4000).default('') }));
  const r = await tx(t, async (q) => classify(q, t.orgId, { fromEmail: input.from.toLowerCase() || null, fromName: null, subject: input.subject, text: input.text }, await loadRules(q, t.orgId)));
  return c.json(r);
});

integrationRoutes.post('/leads/rules/suggest', async (c) => {
  const t = need(c, 'integrations.manage');
  const input = await body(c, z.object({ description: z.string().trim().min(5).max(1500) }));
  const out = await tx(t, async (q) => {
    const m = await resolveModel(q, t.orgId);
    if (!m.ok) throw new ApiError(409, m.code, 'Set up AI first', m.message);
    const cur = await loadRules(q, t.orgId);
    const res = await complete(m.provider, {
      model: m.model,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'You configure email lead triage for a small business. From the owner description, return ONLY JSON: {"instructions": "3-6 short bullet rules for deciding lead vs not and urgency", "leadKeywords": [..up to 20], "urgentKeywords": [..up to 12], "vipDomains": [..], "ignoreDomains": [..]}. Keywords are single words or short phrases in the language customers write in.',
        },
        { role: 'user', content: input.description },
      ],
    });
    const json = res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1);
    let parsed: any;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ApiError(502, 'AI_BAD_OUTPUT', 'The AI reply could not be used', 'Try again or edit the rules by hand.');
    }
    return rulesSchema.parse({ ...cur, ...parsed, instructions: Array.isArray(parsed.instructions) ? parsed.instructions.join('\n') : String(parsed.instructions ?? cur.instructions) });
  });
  return c.json(out); // a suggestion; the app shows it and the owner saves it
});

// ---- Platform OAuth app registration (platform admins only) ----------------------------------------
integrationRoutes.get('/platform/oauth-apps', async (c) => {
  const t = c.get('tenant');
  if (!isPlatformAdmin(t.email)) throw new ApiError(403, 'FORBIDDEN', 'Only the app owner can do this');
  const s = await appStatus();
  return c.json({ items: OAUTH_PROVIDERS.map((p) => ({ id: p, name: PROVIDER_META[p].name, console: PROVIDER_META[p].console, redirectUri: redirectUri(p), ...s[p] })) });
});

integrationRoutes.put('/platform/oauth-apps/:provider', async (c) => {
  const t = c.get('tenant');
  if (!isPlatformAdmin(t.email)) throw new ApiError(403, 'FORBIDDEN', 'Only the app owner can do this');
  const p = providerParam(c.req.param('provider'));
  const input = await body(c, z.object({ clientId: z.string().trim().min(6).max(300), clientSecret: z.string().trim().min(6).max(500) }));
  await saveApp(p, input.clientId, input.clientSecret, t.userId);
  await tx(t, (q) => audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'platform.oauth_app.saved', targetRef: `oauth_app:${p}` }));
  return c.json({ ok: true });
});

integrationRoutes.delete('/platform/oauth-apps/:provider', async (c) => {
  const t = c.get('tenant');
  if (!isPlatformAdmin(t.email)) throw new ApiError(403, 'FORBIDDEN', 'Only the app owner can do this');
  await deleteApp(providerParam(c.req.param('provider')));
  return c.json({ ok: true });
});
