import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import type { Q } from '../core/db';
import { badRequest, notFound } from '../core/errors';
import { publish } from '../core/events';
import { relayAndKick } from '../runtime/outbox';
import { body, query, limitParam } from '../core/validate';

export const workRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Shared repository functions (used by routes, agent tools and workflows)
// ---------------------------------------------------------------------------
export const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  status: z.string().min(1).max(40).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueAt: z.string().datetime({ offset: true }).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  assigneeId: z.string().optional().nullable(),
  domainId: z.string().uuid().optional().nullable(),
});

/** Domains are checked under RLS (a foreign key alone would accept another organization's id). */
async function checkDomain(q: Q, id: string | null | undefined) {
  if (id && !(await q.one('select 1 from domains where id=$1', [id]))) throw badRequest('That domain does not exist here.', { domainId: 'Unknown' });
}

export async function createTask(
  q: Q,
  t: Pick<TenantCtx, 'orgId' | 'workspaceId'>,
  actor: { kind: 'user' | 'agent' | 'workflow'; id: string },
  input: z.infer<typeof taskInput>,
  source: { kind: string; ref?: string | null; importJobId?: string | null } = { kind: 'user' },
) {
  await checkDomain(q, input.domainId);
  const row = await q.one(
    `insert into tasks (org_id, workspace_id, project_id, title, description, status, priority, due_at, assignee_id, source_kind, source_ref, import_job_id, created_by, domain_id)
     values ($1,$2,$3,$4,$5,coalesce($6,'todo'),coalesce($7,'normal'),$8,$9,$10,$11,$12,$13,$14) returning *`,
    [
      t.orgId,
      t.workspaceId,
      input.projectId ?? null,
      input.title,
      input.description ?? null,
      input.status ?? null,
      input.priority ?? null,
      input.dueAt ?? null,
      input.assigneeId ?? null,
      source.kind,
      source.ref ?? null,
      source.importJobId ?? null,
      `${actor.kind}:${actor.id}`,
      input.domainId ?? null,
    ],
  );
  await audit(q, { orgId: t.orgId, actorKind: actor.kind, actorId: actor.id, action: 'task.created', targetRef: `task:${row.id}`, detail: { title: row.title } });
  return row;
}

export async function updateTask(q: Q, t: Pick<TenantCtx, 'orgId'>, actor: { kind: 'user' | 'agent' | 'workflow'; id: string }, id: string, patch: Partial<z.infer<typeof taskInput>>) {
  const cur = await q.one('select * from tasks where id=$1 and deleted_at is null', [id]);
  if (!cur) throw notFound('Task');
  const status = patch.status ?? cur.status;
  await checkDomain(q, patch.domainId);
  const row = await q.one(
    `update tasks set title=$2, description=$3, status=$4, priority=$5, due_at=$6, project_id=$7, assignee_id=$8, domain_id=$9,
       completed_at = case when $4='done' and status<>'done' then now() when $4<>'done' then null else completed_at end,
       updated_at=now() where id=$1 returning *`,
    [
      id,
      patch.title ?? cur.title,
      patch.description !== undefined ? patch.description : cur.description,
      status,
      patch.priority ?? cur.priority,
      patch.dueAt !== undefined ? patch.dueAt : cur.due_at,
      patch.projectId !== undefined ? patch.projectId : cur.project_id,
      patch.assigneeId !== undefined ? patch.assigneeId : cur.assignee_id,
      patch.domainId !== undefined ? patch.domainId : cur.domain_id,
    ],
  );
  await audit(q, { orgId: t.orgId, actorKind: actor.kind, actorId: actor.id, action: 'task.updated', targetRef: `task:${id}`, detail: patch as any });
  return row;
}

export const contactInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320).optional().nullable(),
  phone: z.string().max(60).optional().nullable(),
  title: z.string().max(200).optional().nullable(),
  stage: z.string().max(60).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  companyId: z.string().uuid().optional().nullable(),
});

export async function createContact(
  q: Q,
  t: Pick<TenantCtx, 'orgId' | 'workspaceId'>,
  actor: { kind: 'user' | 'agent' | 'workflow'; id: string },
  input: z.infer<typeof contactInput>,
  source: { kind: string; ref?: string | null; importJobId?: string | null } = { kind: 'user' },
) {
  const row = await q.one(
    `insert into contacts (org_id, workspace_id, company_id, name, email, phone, title, stage, notes, source_kind, source_ref, import_job_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [
      t.orgId,
      t.workspaceId,
      input.companyId ?? null,
      input.name,
      input.email?.toLowerCase() ?? null,
      input.phone ?? null,
      input.title ?? null,
      input.stage ?? null,
      input.notes ?? null,
      source.kind,
      source.ref ?? null,
      source.importJobId ?? null,
      `${actor.kind}:${actor.id}`,
    ],
  );
  if (!source.importJobId) {
    await audit(q, { orgId: t.orgId, actorKind: actor.kind, actorId: actor.id, action: 'contact.created', targetRef: `contact:${row.id}`, detail: { name: row.name } });
  }
  return row;
}

export async function notify(q: Q, orgId: string, userId: string, n: { category: string; title: string; body?: string; ref?: unknown }) {
  await q.exec(`insert into notifications (org_id, user_id, category, title, body, ref) values ($1,$2,$3,$4,$5,$6)`, [
    orgId,
    userId,
    n.category,
    n.title,
    n.body ?? null,
    n.ref ?? null,
  ]);
}

const actorOf = (t: TenantCtx) => ({ kind: 'user' as const, id: t.userId });

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
workRoutes.get('/projects', async (c) => {
  const t = need(c, 'tasks.read');
  const items = await tx(t, (q) =>
    q.many(
      `select p.*, (select count(*)::int from tasks x where x.project_id=p.id and x.deleted_at is null) as task_count,
              (select count(*)::int from tasks x where x.project_id=p.id and x.status='done' and x.deleted_at is null) as done_count
       from projects p where p.status <> 'archived' order by p.created_at desc`,
    ),
  );
  return c.json({ items });
});

workRoutes.post('/projects', async (c) => {
  const t = need(c, 'tasks.write');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(5000).optional() }));
  const row = await tx(t, async (q) => {
    const r = await q.one(`insert into projects (org_id, workspace_id, name, description, created_by) values ($1,$2,$3,$4,$5) returning *`, [
      t.orgId,
      t.workspaceId,
      input.name,
      input.description ?? null,
      t.userId,
    ]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'project.created', targetRef: `project:${r.id}` });
    return r;
  });
  return c.json(row, 201);
});

workRoutes.patch('/projects/:id', async (c) => {
  const t = need(c, 'tasks.write');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(), status: z.enum(['active', 'on_hold', 'done', 'archived']).optional() }));
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `update projects set name=coalesce($2,name), description=coalesce($3,description), status=coalesce($4,status), updated_at=now() where id=$1 returning *`,
      [c.req.param('id'), input.name ?? null, input.description ?? null, input.status ?? null],
    );
    if (!r) throw notFound('Project');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'project.updated', targetRef: `project:${r.id}`, detail: input });
    return r;
  });
  return c.json(row);
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
workRoutes.get('/tasks', async (c) => {
  const t = need(c, 'tasks.read');
  const p = query(
    c,
    z.object({
      status: z.string().optional(),
      projectId: z.string().uuid().optional(),
      domainId: z.string().uuid().optional(),
      q: z.string().max(200).optional(),
      due: z.enum(['overdue', 'today', 'week']).optional(),
      limit: limitParam,
      cursor: z.string().datetime({ offset: true }).optional(),
    }),
  );
  const where = ['deleted_at is null'];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (p.status === 'open') where.push(`status <> 'done'`);
  else if (p.status) add('status = ?', p.status);
  if (p.projectId) add('project_id = ?', p.projectId);
  if (p.domainId) add('domain_id = ?', p.domainId);
  if (p.q) add('title ilike ?', `%${p.q}%`);
  if (p.due === 'overdue') where.push(`due_at < now() and status <> 'done'`);
  if (p.due === 'today') where.push(`due_at::date = (now() at time zone 'utc')::date`);
  if (p.due === 'week') where.push(`due_at < now() + interval '7 days' and status <> 'done'`);
  if (p.cursor) add('created_at < ?', p.cursor);
  args.push(p.limit + 1);
  const rows = await tx(t, (q) => q.many(`select * from tasks where ${where.join(' and ')} order by created_at desc limit $${args.length}`, args));
  const more = rows.length > p.limit;
  const items = rows.slice(0, p.limit);
  return c.json({ items, nextCursor: more ? new Date(items[items.length - 1].created_at).toISOString() : null });
});

workRoutes.post('/tasks', async (c) => {
  const t = need(c, 'tasks.write');
  const input = await body(c, taskInput);
  const row = await tx(t, async (q) => {
    const r = await createTask(q, t, actorOf(t), input);
    await publish(q, t, [{ type: 'task.created', id: `task:${r.id}`, data: r }]);
    return r;
  });
  await relayAndKick();
  return c.json(row, 201);
});

workRoutes.get('/tasks/:id', async (c) => {
  const t = need(c, 'tasks.read');
  const data = await tx(t, async (q) => {
    const task = await q.one('select * from tasks where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!task) throw notFound('Task');
    const comments = await q.many('select * from task_comments where task_id=$1 order by created_at', [task.id]);
    return { ...task, comments };
  });
  return c.json(data);
});

workRoutes.patch('/tasks/:id', async (c) => {
  const t = need(c, 'tasks.write');
  const input = await body(c, taskInput.partial());
  const row = await tx(t, (q) => updateTask(q, t, actorOf(t), c.req.param('id'), input));
  return c.json(row);
});

workRoutes.delete('/tasks/:id', async (c) => {
  const t = need(c, 'tasks.write');
  await tx(t, async (q) => {
    const n = await q.exec('update tasks set deleted_at=now() where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!n) throw notFound('Task');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'task.deleted', targetRef: `task:${c.req.param('id')}` });
  });
  return c.json({ ok: true });
});

workRoutes.post('/tasks/:id/comments', async (c) => {
  const t = need(c, 'tasks.write');
  const { body: text } = await body(c, z.object({ body: z.string().trim().min(1).max(5000) }));
  const row = await tx(t, async (q) => {
    const task = await q.one('select id from tasks where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!task) throw notFound('Task');
    return q.one(`insert into task_comments (org_id, task_id, body, author_id) values ($1,$2,$3,$4) returning *`, [t.orgId, task.id, text, t.userId]);
  });
  return c.json(row, 201);
});

// ---------------------------------------------------------------------------
// Contacts & companies
// ---------------------------------------------------------------------------
workRoutes.get('/contacts', async (c) => {
  const t = need(c, 'contacts.read');
  const p = query(c, z.object({ q: z.string().max(200).optional(), limit: limitParam }));
  const items = await tx(t, (q) =>
    q.many(
      `select c.*, co.name as company_name from contacts c left join companies co on co.id = c.company_id
       where c.deleted_at is null and ($1::text is null or c.name ilike $1 or c.email ilike $1)
       order by c.created_at desc limit $2`,
      [p.q ? `%${p.q}%` : null, p.limit],
    ),
  );
  return c.json({ items });
});

workRoutes.post('/contacts', async (c) => {
  const t = need(c, 'contacts.write');
  const input = await body(c, contactInput);
  const row = await tx(t, async (q) => {
    const r = await createContact(q, t, actorOf(t), input);
    await publish(q, t, [{ type: 'contact.created', id: `contact:${r.id}`, data: r }]);
    return r;
  });
  await relayAndKick();
  return c.json(row, 201);
});

workRoutes.patch('/contacts/:id', async (c) => {
  const t = need(c, 'contacts.write');
  const input = await body(c, contactInput.partial());
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `update contacts set name=coalesce($2,name), email=coalesce($3,email), phone=coalesce($4,phone), title=coalesce($5,title),
         stage=coalesce($6,stage), notes=coalesce($7,notes), updated_at=now() where id=$1 and deleted_at is null returning *`,
      [c.req.param('id'), input.name ?? null, input.email ?? null, input.phone ?? null, input.title ?? null, input.stage ?? null, input.notes ?? null],
    );
    if (!r) throw notFound('Contact');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'contact.updated', targetRef: `contact:${r.id}` });
    return r;
  });
  return c.json(row);
});

workRoutes.delete('/contacts/:id', async (c) => {
  const t = need(c, 'contacts.write');
  await tx(t, async (q) => {
    const n = await q.exec('update contacts set deleted_at=now() where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!n) throw notFound('Contact');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'contact.deleted', targetRef: `contact:${c.req.param('id')}` });
  });
  return c.json({ ok: true });
});

workRoutes.get('/companies', async (c) => {
  const t = need(c, 'contacts.read');
  const items = await tx(t, (q) => q.many('select * from companies where deleted_at is null order by name limit 200'));
  return c.json({ items });
});

workRoutes.post('/companies', async (c) => {
  const t = need(c, 'contacts.write');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(200), domain: z.string().max(200).optional(), notes: z.string().max(5000).optional() }));
  const row = await tx(t, async (q) => {
    const r = await q.one(`insert into companies (org_id, workspace_id, name, domain, notes, created_by) values ($1,$2,$3,$4,$5,$6) returning *`, [
      t.orgId,
      t.workspaceId,
      input.name,
      input.domain ?? null,
      input.notes ?? null,
      `user:${t.userId}`,
    ]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'company.created', targetRef: `company:${r.id}` });
    return r;
  });
  return c.json(row, 201);
});

// ---------------------------------------------------------------------------
// Documents & memory
// ---------------------------------------------------------------------------
workRoutes.get('/documents', async (c) => {
  const t = need(c, 'documents.read');
  const p = query(c, z.object({ q: z.string().max(200).optional(), kind: z.enum(['document', 'note', 'draft_email']).optional(), limit: limitParam }));
  const items = await tx(t, (q) =>
    q.many(
      `select id, kind, title, left(body, 280) as excerpt, folder, source_kind, source_ref, version, created_at, updated_at
       from documents where deleted_at is null and ($1::text is null or kind=$1)
       and ($2::text is null or search @@ websearch_to_tsquery('simple', $2) or title ilike '%' || $2 || '%')
       order by updated_at desc limit $3`,
      [p.kind ?? null, p.q ?? null, p.limit],
    ),
  );
  return c.json({ items });
});

workRoutes.get('/documents/:id', async (c) => {
  const t = need(c, 'documents.read');
  const d = await tx(t, (q) => q.one('select id, kind, title, body, folder, source_kind, source_ref, version, file_id, created_at, updated_at from documents where id=$1 and deleted_at is null', [c.req.param('id')]));
  if (!d) throw notFound('Document');
  return c.json(d);
});

workRoutes.post('/documents', async (c) => {
  const t = need(c, 'documents.write');
  const input = await body(c, z.object({ title: z.string().trim().min(1).max(300), body: z.string().max(200_000), folder: z.string().max(100).optional(), kind: z.enum(['document', 'note']).default('note') }));
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `insert into documents (org_id, workspace_id, kind, title, body, folder, source_kind, created_by) values ($1,$2,$3,$4,$5,$6,'user',$7) returning id, kind, title, folder, created_at`,
      [t.orgId, t.workspaceId, input.kind, input.title, input.body, input.folder ?? null, `user:${t.userId}`],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'document.created', targetRef: `document:${r.id}` });
    return r;
  });
  return c.json(row, 201);
});

workRoutes.delete('/documents/:id', async (c) => {
  const t = need(c, 'documents.write');
  await tx(t, async (q) => {
    const n = await q.exec('update documents set deleted_at=now() where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!n) throw notFound('Document');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'document.deleted', targetRef: `document:${c.req.param('id')}` });
  });
  return c.json({ ok: true });
});

workRoutes.get('/memory', async (c) => {
  const t = need(c, 'memory.read');
  const p = query(c, z.object({ status: z.string().optional() }));
  const items = await tx(t, (q) =>
    q.many(`select * from memory_records where ($1::text is null or status=$1) and status <> 'archived' and deleted_at is null order by created_at desc limit 200`, [p.status ?? null]),
  );
  return c.json({ items });
});

workRoutes.post('/memory', async (c) => {
  const t = need(c, 'memory.write');
  const input = await body(c, z.object({ content: z.string().trim().min(1).max(2000), kind: z.enum(['fact', 'preference', 'policy', 'context']).default('fact') }));
  const row = await tx(t, async (q) => {
    const r = await q.one(
      `insert into memory_records (org_id, workspace_id, kind, content, source_kind, confidence, status, created_by) values ($1,$2,$3,$4,'user',1,'active',$5) returning *`,
      [t.orgId, t.workspaceId, input.kind, input.content, `user:${t.userId}`],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'memory.created', targetRef: `memory:${r.id}` });
    return r;
  });
  return c.json(row, 201);
});

workRoutes.post('/memory/:id/confirm', async (c) => {
  const t = need(c, 'memory.write');
  const row = await tx(t, async (q) => {
    const r = await q.one(`update memory_records set status='active', confidence=1, updated_at=now() where id=$1 and status='proposed' returning *`, [c.req.param('id')]);
    if (!r) throw notFound('Proposed memory');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'memory.confirmed', targetRef: `memory:${r.id}` });
    return r;
  });
  return c.json(row);
});

workRoutes.post('/memory/:id/supersede', async (c) => {
  const t = need(c, 'memory.write');
  const { content } = await body(c, z.object({ content: z.string().trim().min(1).max(2000) }));
  const row = await tx(t, async (q) => {
    const old = await q.one(`select * from memory_records where id=$1 and status in ('active','proposed')`, [c.req.param('id')]);
    if (!old) throw notFound('Memory');
    const r = await q.one(
      `insert into memory_records (org_id, workspace_id, scope, kind, content, source_kind, confidence, status, created_by) values ($1,$2,$3,$4,$5,'user',1,'active',$6) returning *`,
      [t.orgId, old.workspace_id, old.scope, old.kind, content, `user:${t.userId}`],
    );
    await q.exec(`update memory_records set status='superseded', superseded_by=$2, updated_at=now() where id=$1`, [old.id, r.id]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'memory.superseded', targetRef: `memory:${old.id}`, detail: { by: r.id } });
    return r;
  });
  return c.json(row, 201);
});

workRoutes.delete('/memory/:id', async (c) => {
  const t = need(c, 'memory.write');
  await tx(t, async (q) => {
    const n = await q.exec(`delete from memory_records where id=$1`, [c.req.param('id')]);
    if (!n) throw notFound('Memory');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'memory.deleted', targetRef: `memory:${c.req.param('id')}` });
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Search, dashboard, notifications
// ---------------------------------------------------------------------------
workRoutes.get('/search', async (c) => {
  const t = c.get('tenant');
  const { q: term } = query(c, z.object({ q: z.string().trim().min(1).max(200) }));
  const like = `%${term}%`;
  const results = await tx(t, async (q) => {
    const tasks = await q.many(`select id, title, status from tasks where deleted_at is null and title ilike $1 limit 10`, [like]);
    const contacts = await q.many(`select id, name, email from contacts where deleted_at is null and (name ilike $1 or email ilike $1) limit 10`, [like]);
    const documents = await q.many(
      `select id, title, kind from documents where deleted_at is null and (search @@ websearch_to_tsquery('simple',$1) or title ilike $2) limit 10`,
      [term, like],
    );
    const memory = await q.many(`select id, content, status, source_kind from memory_records where status in ('active','proposed') and content ilike $1 limit 10`, [like]);
    return { tasks, contacts, documents, memory };
  });
  return c.json(results);
});

workRoutes.get('/dashboard', async (c) => {
  const t = c.get('tenant');
  const asOf = new Date().toISOString();
  const data = await tx(t, async (q) => {
    const counts = await q.one(
      `select
         (select count(*)::int from tasks where deleted_at is null and status <> 'done') as open_tasks,
         (select count(*)::int from tasks where deleted_at is null and status <> 'done' and due_at < now()) as overdue_tasks,
         (select count(*)::int from tasks where deleted_at is null and status <> 'done' and due_at >= now() and due_at < now() + interval '7 days') as due_week,
         (select count(*)::int from tasks where deleted_at is null and status = 'done' and completed_at > now() - interval '7 days') as done_week,
         (select count(*)::int from contacts where deleted_at is null) as contacts,
         (select count(*)::int from documents where deleted_at is null) as documents,
         (select count(*)::int from approval_requests where status='pending' and expires_at > now()) as pending_approvals,
         (select count(*)::int from agent_runs where created_at > now() - interval '24 hours') as runs_today,
         (select count(*)::int from workflows where status='enabled') as active_workflows`,
    );
    const focus = await q.many(
      `select id, title, status, priority, due_at from tasks where deleted_at is null and status <> 'done'
       order by (due_at is null), due_at asc, case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end limit 5`,
    );
    const approvals = await q.many(`select id, action, risk, preview, created_at from approval_requests where status='pending' and expires_at > now() order by created_at desc limit 5`);
    const activity = await q.many(`select id, actor_kind, action, target_ref, at from audit_events order by id desc limit 10`);
    const ws = await q.one('select config, config_version from workspaces where id=$1', [t.workspaceId]);
    const profile = await q.one('select profile from business_profiles where workspace_id=$1', [t.workspaceId]);
    return { counts, focus, approvals, activity, config: ws?.config, configVersion: ws?.config_version ?? 0, profile: profile?.profile ?? {} };
  });
  const src = (s: string) => ({ source: s, asOf });
  return c.json({
    asOf,
    configured: data.configVersion > 0,
    businessName: data.profile?.businessName ?? null,
    widgets: [
      { key: 'open_tasks', label: 'Open tasks', value: data.counts.open_tasks, ...src('tasks') },
      { key: 'overdue_tasks', label: 'Overdue', value: data.counts.overdue_tasks, ...src('tasks.due_at < now') },
      { key: 'due_week', label: 'Due in 7 days', value: data.counts.due_week, ...src('tasks.due_at') },
      { key: 'done_week', label: 'Done this week', value: data.counts.done_week, ...src('tasks.completed_at') },
      { key: 'pending_approvals', label: 'Waiting for you', value: data.counts.pending_approvals, ...src('approval_requests') },
      { key: 'contacts', label: 'Contacts', value: data.counts.contacts, ...src('contacts') },
      { key: 'documents', label: 'Library items', value: data.counts.documents, ...src('documents') },
      { key: 'runs_today', label: 'Agent runs (24h)', value: data.counts.runs_today, ...src('agent_runs') },
      { key: 'active_workflows', label: 'Active workflows', value: data.counts.active_workflows, ...src('workflows') },
    ],
    focus: data.focus,
    approvals: data.approvals,
    activity: data.activity,
  });
});

workRoutes.get('/notifications', async (c) => {
  const t = c.get('tenant');
  const items = await tx(t, (q) => q.many(`select * from notifications where user_id=$1 order by created_at desc limit 50`, [t.userId]));
  return c.json({ items, unread: items.filter((n: any) => !n.read_at).length });
});

workRoutes.post('/notifications/:id/read', async (c) => {
  const t = c.get('tenant');
  await tx(t, (q) => q.exec(`update notifications set read_at=now() where id=$1 and user_id=$2`, [c.req.param('id'), t.userId]));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Domains (phase 7, ADR-1): labels inside a workspace (Personal, Work, Learning, ...). Rename, hide, reorder, add.
// ---------------------------------------------------------------------------
const DOMAIN_ICON = z.string().regex(/^[a-z_]{1,40}$/);
const MAX_DOMAINS = 20;

workRoutes.get('/domains', async (c) => {
  const t = need(c, 'tasks.read');
  const items = await tx(t, (q) =>
    q.many(
      `select d.id, d.name, d.icon, d.enabled, d.position, (select count(*)::int from tasks k where k.domain_id=d.id and k.deleted_at is null and k.status <> 'done') as open_tasks
         from domains d where d.workspace_id=$1 order by d.position, d.created_at`,
      [t.workspaceId],
    ),
  );
  return c.json({ items });
});

workRoutes.post('/domains', async (c) => {
  const t = need(c, 'tasks.write');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(40), icon: DOMAIN_ICON.optional() }));
  const row = await tx(t, async (q) => {
    const n = await q.one<{ n: number }>('select count(*)::int as n from domains where workspace_id=$1', [t.workspaceId]);
    if ((n?.n ?? 0) >= MAX_DOMAINS) throw badRequest(`You can have up to ${MAX_DOMAINS} domains.`);
    if (await q.one('select 1 from domains where workspace_id=$1 and lower(name)=lower($2)', [t.workspaceId, input.name])) throw badRequest('A domain with that name already exists.', { name: 'Taken' });
    const r = await q.one(
      `insert into domains (org_id, workspace_id, name, icon, position, created_by) values ($1,$2,$3,coalesce($4,'label'),$5,$6) returning id, name, icon, enabled, position`,
      [t.orgId, t.workspaceId, input.name, input.icon ?? null, n?.n ?? 0, `user:${t.userId}`],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'domain.created', targetRef: `domain:${r.id}`, detail: { name: input.name } });
    return r;
  });
  return c.json(row, 201);
});

workRoutes.patch('/domains/:id', async (c) => {
  const t = need(c, 'tasks.write');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(40).optional(), icon: DOMAIN_ICON.optional(), enabled: z.boolean().optional(), position: z.number().int().min(0).max(100).optional() }));
  const row = await tx(t, async (q) => {
    const d = await q.one('select id from domains where id=$1 and workspace_id=$2', [c.req.param('id'), t.workspaceId]);
    if (!d) throw notFound('Domain');
    if (input.name && (await q.one('select 1 from domains where workspace_id=$1 and lower(name)=lower($2) and id<>$3', [t.workspaceId, input.name, d.id]))) throw badRequest('A domain with that name already exists.', { name: 'Taken' });
    const r = await q.one(
      `update domains set name=coalesce($2,name), icon=coalesce($3,icon), enabled=coalesce($4,enabled), position=coalesce($5,position), updated_at=now() where id=$1 returning id, name, icon, enabled, position`,
      [d.id, input.name ?? null, input.icon ?? null, input.enabled ?? null, input.position ?? null],
    );
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'domain.updated', targetRef: `domain:${d.id}`, detail: input });
    return r;
  });
  return c.json(row);
});
