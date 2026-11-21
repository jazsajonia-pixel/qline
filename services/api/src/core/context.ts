import type { Context, MiddlewareHandler } from 'hono';
import { isRole, type Permission, type Role, can } from '@qline/policy';
import { getAuth } from './auth';
import { withTenant, type Q } from './db';
import { ApiError, forbidden } from './errors';

export interface UserCtx {
  userId: string;
  email: string;
  name: string;
  sessionId: string;
  /** True once the address is proven (Google sign-in). Password sign-up does not verify email yet. */
  emailVerified?: boolean;
  /** All interactive sessions are human. Service actors never get a Better Auth session. */
  human: true;
}
export interface TenantCtx extends UserCtx {
  orgId: string;
  workspaceId: string;
  role: Role;
  correlationId: string;
}

export type Env = { Variables: { user: UserCtx; tenant: TenantCtx; correlationId: string } };

export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const session = await getAuth().api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  c.set('user', {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.session.id,
    emailVerified: session.user.emailVerified === true,
    human: true,
  });
  await next();
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves the active org from X-Qline-Org and checks membership on the server (docs/04 §5). */
export const requireTenant: MiddlewareHandler<Env> = async (c, next) => {
  const user = c.get('user');
  const orgId = c.req.header('x-qline-org') ?? '';
  if (!UUID.test(orgId)) throw new ApiError(400, 'ORG_REQUIRED', 'Choose an organization', 'Send the X-Qline-Org header.');
  const row = await withTenant({ orgId, userId: user.userId }, (q) =>
    q.one<{ role: string; status: string; workspace_id: string; org_status: string }>(
      `select m.role, m.status, o.status as org_status,
              (select w.id from workspaces w where w.org_id = m.org_id order by w.created_at limit 1) as workspace_id
       from organization_members m join organizations o on o.id = m.org_id
       where m.org_id = $1 and m.user_id = $2`,
      [orgId, user.userId],
    ),
  );
  // Not a member → 404, so the existence of the org is not leaked.
  if (!row || row.status !== 'active' || !isRole(row.role)) throw new ApiError(404, 'TENANT_NOT_FOUND', 'Organization not found');
  c.set('tenant', { ...user, orgId, workspaceId: row.workspace_id, role: row.role, correlationId: c.get('correlationId') });
  await next();
};

export function need(c: Context<Env>, perm: Permission) {
  const t = c.get('tenant');
  if (!can(t.role, perm)) throw forbidden(`Your role (${t.role}) does not include ${perm}.`);
  return t;
}

/** A person's own request (HTTP route): may see their private knowledge. */
export function tx<T>(t: { orgId: string | null; userId: string }, fn: (q: Q) => Promise<T>) {
  return withTenant({ orgId: t.orgId, userId: t.userId, runKind: 'interactive' }, fn);
}
