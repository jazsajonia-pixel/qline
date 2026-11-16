import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getAuth } from './core/auth';
import { requireTenant, requireUser, tx, type Env } from './core/context';
import { env } from './core/env';
import { ApiError } from './core/errors';
import { agentRoutes } from './modules/agents';
import { aiRoutes } from './modules/ai';
import { importRoutes } from './modules/imports';
import { onboardingRoutes } from './modules/onboarding';
import { memberRoutes, orgRoutes } from './modules/orgs';
import { internalRoutes, systemRoutes } from './modules/system';
import { workflowRoutes } from './modules/workflows';
import { workRoutes } from './modules/work';
import { integrationRoutes, oauthPublicRoutes } from './modules/integrations';
import { googleSignInRoutes } from './modules/google-signin';
import { voiceRoutes } from './modules/voice';

export const app = new Hono<Env>();

app.use('*', async (c, next) => {
  const incoming = c.req.header('x-correlation-id');
  const id = incoming && /^[0-9a-f-]{36}$/i.test(incoming) ? incoming : randomUUID();
  c.set('correlationId', id);
  await next();
  c.header('x-correlation-id', id);
});

app.use(
  '/v1/*',
  cors({
    origin: (o) => (env.webOrigins.includes(o) ? o : null),
    credentials: true,
    allowHeaders: ['authorization', 'content-type', 'x-qline-org', 'x-qline-client', 'idempotency-key', 'last-event-id', 'x-correlation-id'],
    exposeHeaders: ['set-auth-token', 'x-correlation-id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }),
);

// Old mobile builds get a clear upgrade message (docs/06 §1).
app.use('/v1/*', async (c, next) => {
  const client = c.req.header('x-qline-client'); // e.g. "android/12"
  const build = Number(client?.split('/')[1] ?? 'NaN');
  if (env.minClientBuild && Number.isFinite(build) && build < env.minClientBuild) {
    throw new ApiError(426, 'CLIENT_UPGRADE_REQUIRED', 'Please update Qline', 'This version of the app is no longer supported.');
  }
  await next();
});

app.onError((err, c) => {
  const correlationId = c.get('correlationId');
  if (err instanceof ApiError) {
    return c.json(
      { type: `https://qline.app/errors/${err.code.toLowerCase()}`, title: err.title, status: err.status, code: err.code, detail: err.detail, fields: err.fields, correlationId },
      err.status as any,
      { 'content-type': 'application/problem+json' },
    );
  }
  console.error(JSON.stringify({ level: 'error', correlationId, path: c.req.path, message: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0, 4) }));
  return c.json({ type: 'about:blank', title: 'Something went wrong', status: 500, code: 'INTERNAL', correlationId }, 500, { 'content-type': 'application/problem+json' });
});

app.notFound((c) => c.json({ title: 'Not found', status: 404, code: 'NOT_FOUND' }, 404, { 'content-type': 'application/problem+json' }));

app.get('/', (c) => c.json({ name: 'Qline API', version: env.version, docs: '/v1/health' }));
app.route('/internal', internalRoutes);

// Public and user-level routes first: their handlers answer before the tenant middleware below.
app.on(['GET', 'POST'], '/v1/auth/*', (c) => getAuth().handler(c.req.raw));
app.route('/v1', systemRoutes);
app.route('/v1', orgRoutes);
app.route('/v1', oauthPublicRoutes);
app.route('/v1', googleSignInRoutes);

// Everything else is tenant-scoped.
app.use('/v1/*', requireUser, requireTenant);

// Idempotency-Key for create requests (docs/06 §1): same key → same response.
app.use('/v1/*', async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (c.req.method !== 'POST' || !key) return next();
  if (key.length > 100) throw new ApiError(400, 'VALIDATION_FAILED', 'Idempotency-Key is too long');
  const t = c.get('tenant');
  const route = c.req.path;
  const prior = await tx(t, (q) => q.one('select route, status, response from idempotency_keys where org_id=$1 and user_id=$2 and key=$3', [t.orgId, t.userId, key]));
  if (prior) {
    if (prior.route !== route) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for a different request');
    c.header('idempotent-replay', 'true');
    return c.json(prior.response, prior.status);
  }
  await next();
  if (c.res.status < 300 && c.res.headers.get('content-type')?.includes('application/json')) {
    const data = await c.res.clone().json().catch(() => null);
    if (data) await tx(t, (q) => q.exec('insert into idempotency_keys (org_id, user_id, key, route, status, response) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [t.orgId, t.userId, key, route, c.res.status, JSON.stringify(data)]));
  }
});

app.route('/v1', memberRoutes);
app.route('/v1', workRoutes);
app.route('/v1', agentRoutes);
app.route('/v1', aiRoutes);
app.route('/v1', workflowRoutes);
app.route('/v1', onboardingRoutes);
app.route('/v1', importRoutes);
app.route('/v1', integrationRoutes);
app.route('/v1', voiceRoutes);
