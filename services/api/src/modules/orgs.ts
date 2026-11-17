import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { canAssignRole, type AgentTemplate } from '@qline/policy';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import type { Q } from '../core/db';
import { ApiError, badRequest, forbidden, notFound } from '../core/errors';
import { body } from '../core/validate';
import { agentSeed, DEFAULT_CONFIG, TEMPLATES } from './templates';
import { env } from '../core/env';
import { getAuth } from '../core/auth';

export async function seedWorkspace(q: Q, orgId: string, userId: string): Promise<string> {
  const ws = await q.one<{ id: string }>(
    `insert into workspaces (org_id, name, config, config_version) values ($1, 'Main', $2, 0) returning id`,
    [orgId, DEFAULT_CONFIG],
  );
  const wsId = ws!.id;
  await q.exec(`insert into business_profiles (org_id, workspace_id, profile) values ($1,$2,'{}')`, [orgId, wsId]);
  for (const t of TEMPLATES) {
    const seed = agentSeed(t as AgentTemplate);
    const a = await q.one<{ id: string }>(
      `insert into agents (org_id, workspace_id, template, name, status, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
      [orgId, wsId, t, seed.name, t === 'ceo' ? 'active' : 'paused', userId],
    );
    await q.exec(
      `insert into agent_versions (org_id, agent_id, version, instructions, model, tool_allowlist, created_by)
       values ($1,$2,1,$3,$4,$5,$6)`,
      [orgId, a!.id, seed.instructions, 'default', seed.allowlist, userId],
    );
  }
  return wsId;
}

export const orgRoutes = new Hono<Env>();

// --- user-level (no org header) -------------------------------------------
// Session controls are account-scoped, never organization-scoped. Better Auth
// resolves the bearer token from the incoming request and only returns the
// authenticated user's sessions. Never return the bearer/session token itself.
orgRoutes.get('/me/sessions', requireUser, async (c) => {
  const sessions = await getAuth().api.listSessions({ headers: c.req.raw.headers });
  c.header('Cache-Control', 'no-store');
  return c.json({
    items: sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      current: session.id === c.get('user').sessionId,
    })),
  });
});

orgRoutes.delete('/me/sessions/:id', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!id || id.length > 128) {
    throw new ApiError(400, 'INVALID_SESSION_ID', 'Invalid session id');
  }

  // Resolve the id only against the authenticated user's own session set.
  // The raw token stays server-side and is never accepted from the caller.
  const sessions = await getAuth().api.listSessions({ headers: c.req.raw.headers });
  const target = sessions.find((session) => session.id === id);
  if (!target) {
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found');
  }

  await getAuth().api.revokeSession({
    body: { token: target.token },
    headers: c.req.raw.headers,
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ id: target.id, revoked: true });
});

orgRoutes.get('/me', requireUser, async (c) => {
  const u = c.get('user');
  const orgs = await tx({ orgId: null, userId: u.userId }, (q) =>
    q.many(
      `select o.id, o.name, o.status, m.role from organization_members m join organizations o on o.id = m.org_id
       where m.user_id = $1 and m.status = 'active' order by m.joined_at`,
      [u.userId],
    ),
  );
  return c.json({ user: { id: u.userId, email: u.email, name: u.name }, orgs });
});

orgRoutes.get('/orgs', requireUser, async (c) => {
  const u = c.get('user');
  const orgs = await tx({ orgId: null, userId: u.userId }, (q) =>
    q.many(
      `select o.id, o.name, o.status, m.role from organization_members m join organizations o on o.id = m.org_id
       where m.user_id = $1 and m.status='active' order by m.joined_at`,
      [u.userId],
    ),
  );
  return c.json({ items: orgs });
});

orgRoutes.post('/orgs', requireUser, async (c) => {
  const u = c.get('user');
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
  const orgId = randomUUID();
  const result = await tx({ orgId, userId: u.userId }, async (q) => {
    await q.exec(`insert into organizations (id, name, created_by) values ($1,$2,$3)`, [orgId, name, u.userId]);
    await q.exec(`insert into organization_members (org_id, user_id, role) values ($1,$2,'owner')`, [orgId, u.userId]);
    const workspaceId = await seedWorkspace(q, orgId, u.userId);
    await audit(q, { orgId, actorKind: 'user', actorId: u.userId, action: 'org.created', targetRef: `org:${orgId}`, detail: { name } });
    return { id: orgId, name, role: 'owner', workspaceId };
  });
  return c.json(result, 201);
});

const hashCode = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

orgRoutes.post('/invitations/accept', requireUser, async (c) => {
  const u = c.get('user');
  const { code } = await body(c, z.object({ code: z.string().trim().min(6).max(64) }));
  const h = hashCode(code);
  const inv = await tx({ orgId: null, userId: u.userId }, (q) =>
    q.one<{ id: string; org_id: string; role: string; status: string; expires_at: string }>('select * from qline_invitation_by_hash($1)', [h]),
  );
  if (!inv || inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
    throw new ApiError(404, 'INVITATION_INVALID', 'Invitation not valid', 'The code is wrong, used or expired.');
  }
  await tx({ orgId: inv.org_id, userId: u.userId }, async (q) => {
    const exists = await q.one('select 1 from organization_members where org_id=$1 and user_id=$2', [inv.org_id, u.userId]);
    if (exists) throw new ApiError(409, 'ALREADY_MEMBER', 'Already a member');
    await q.exec(`insert into organization_members (org_id, user_id, role) values ($1,$2,$3)`, [inv.org_id, u.userId, inv.role]);
    await q.exec(`update invitations set status='accepted', accepted_by=$2 where id=$1`, [inv.id, u.userId]);
    await audit(q, { orgId: inv.org_id, actorKind: 'user', actorId: u.userId, action: 'member.joined', targetRef: `invitation:${inv.id}`, detail: { role: inv.role } });
  });
  return c.json({ orgId: inv.org_id, role: inv.role });
});

// --- org-scoped -------------------------------------------------------------
export const memberRoutes = new Hono<Env>();

memberRoutes.get('/org', async (c) => {
  const t = c.get('tenant');
  const org = await tx(t, (q) => q.one('select id, name, status, settings, created_at from organizations where id=$1', [t.orgId]));
  return c.json({ ...org, role: t.role, workspaceId: t.workspaceId });
});

memberRoutes.patch('/org', async (c) => {
  const t = need(c, 'org.manage');
  const { name } = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
  await tx(t, async (q) => {
    await q.exec('update organizations set name=$2, updated_at=now() where id=$1', [t.orgId, name]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'org.renamed', targetRef: `org:${t.orgId}`, detail: { name } });
  });
  return c.json({ ok: true });
});

memberRoutes.get('/members', async (c) => {
  const t = c.get('tenant');
  const items = await tx(t, (q) =>
    q.many(
      `select m.user_id as id, u.name, u.email, m.role, m.status, m.joined_at
       from organization_members m join "user" u on u.id = m.user_id where m.org_id=$1 order by m.joined_at`,
      [t.orgId],
    ),
  );
  const invitations = await tx(t, (q) =>
    q.many(`select id, email, role, status, expires_at, created_at from invitations where org_id=$1 and status='pending' order by created_at desc`, [t.orgId]),
  );
  return c.json({ items, invitations });
});

memberRoutes.post('/invitations', async (c) => {
  const t = need(c, 'members.manage');
  const input = await body(c, z.object({ role: z.enum(['admin', 'manager', 'member', 'viewer']), email: z.string().email().optional() }));
  if (!canAssignRole(t.role, input.role)) throw forbidden(`A ${t.role} cannot invite a ${input.role}.`);
  // Readable one-time code; only its hash is stored.
  const code = randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `insert into invitations (org_id, code_hash, email, role, invited_by, expires_at) values ($1,$2,$3,$4,$5, now() + interval '7 days') returning id, role, expires_at`,
      [t.orgId, hashCode(code), input.email ?? null, input.role, t.userId],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'invitation.created', targetRef: `invitation:${r.id}`, detail: { role: input.role } });
    return r;
  });
  // Email delivery is not configured, so the code is returned for the inviter to share.
  return c.json({ ...row, code, delivery: 'share_code_manually' }, 201);
});

memberRoutes.delete('/invitations/:id', async (c) => {
  const t = need(c, 'members.manage');
  const n = await tx(t, async (q) => {
    const n = await q.exec(`update invitations set status='revoked' where id=$1 and status='pending'`, [c.req.param('id')]);
    if (n) await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'invitation.revoked', targetRef: `invitation:${c.req.param('id')}` });
    return n;
  });
  if (!n) throw notFound('Invitation');
  return c.json({ ok: true });
});

memberRoutes.patch('/members/:userId', async (c) => {
  const t = need(c, 'members.manage');
  const target = c.req.param('userId');
  const input = await body(c, z.object({ role: z.enum(['admin', 'manager', 'member', 'viewer']).optional(), status: z.enum(['active', 'suspended']).optional() }));
  if (target === t.userId) throw badRequest('You cannot change your own role or status.');
  await tx(t, async (q) => {
    const m = await q.one<{ role: any }>('select role from organization_members where org_id=$1 and user_id=$2', [t.orgId, target]);
    if (!m) throw notFound('Member');
    if (m.role === 'owner') throw forbidden('The owner cannot be changed here.');
    if (!canAssignRole(t.role, m.role)) throw forbidden(`A ${t.role} cannot change a ${m.role}.`);
    if (input.role && !canAssignRole(t.role, input.role)) throw forbidden(`A ${t.role} cannot assign ${input.role}.`);
    await q.exec('update organization_members set role=coalesce($3, role), status=coalesce($4,status) where org_id=$1 and user_id=$2', [
      t.orgId,
      target,
      input.role ?? null,
      input.status ?? null,
    ]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'member.updated', targetRef: `user:${target}`, detail: input });
  });
  return c.json({ ok: true });
});

memberRoutes.delete('/members/:userId', async (c) => {
  const t = c.get('tenant') as TenantCtx;
  const target = c.req.param('userId');
  const self = target === t.userId;
  if (!self) need(c, 'members.manage');
  await tx(t, async (q) => {
    const m = await q.one<{ role: any }>('select role from organization_members where org_id=$1 and user_id=$2', [t.orgId, target]);
    if (!m) throw notFound('Member');
    if (m.role === 'owner') throw forbidden('The owner cannot leave or be removed.');
    if (!self && !canAssignRole(t.role, m.role)) throw forbidden();
    await q.exec('delete from organization_members where org_id=$1 and user_id=$2', [t.orgId, target]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: self ? 'member.left' : 'member.removed', targetRef: `user:${target}` });
  });
  return c.json({ ok: true });
});
