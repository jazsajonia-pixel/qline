import { Hono } from 'hono';
import { z } from 'zod';
import { audit } from '../core/audit';
import { need, tx, type Env } from '../core/context';
import type { Q } from '../core/db';
import { ApiError, badRequest, notFound } from '../core/errors';
import { body, query } from '../core/validate';

/**
 * Knowledge OS (docs/14), v1.6 scope: K1 foundation (categories, entries with revisions,
 * private/shared visibility enforced by RLS, typed links) and K3 map (graph API).
 * Entries live in memory_records, so /memory and the memory.* agent tools keep working.
 * Privacy is enforced by the database (restrictive RLS + qline.run_kind), not by this file:
 * a hidden row simply never comes back from a query.
 */

export const KNOWLEDGE_KINDS = ['fact', 'preference', 'policy', 'context', 'process', 'decision', 'lesson', 'note'] as const;
export const RELATIONS = ['about', 'part_of', 'depends_on', 'decided_in', 'source_of', 'owned_by', 'supersedes', 'contradicts', 'related_to'] as const;
export const TARGET_TYPES = ['entry', 'document', 'contact', 'company', 'project', 'task'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/** Default taxonomy for a small business (docs/14 §4.2), versioned like the agent templates. */
export const CATEGORY_TEMPLATE = 'smb-default@1';
export const DEFAULT_CATEGORIES: { key: string; name: string }[] = [
  { key: 'business', name: 'About the business' },
  { key: 'offers', name: 'Offers and pricing' },
  { key: 'customers', name: 'Customers' },
  { key: 'team', name: 'Team' },
  { key: 'processes', name: 'How we work' },
  { key: 'policies', name: 'Policies' },
  { key: 'decisions', name: 'Decisions' },
  { key: 'projects', name: 'Projects' },
  { key: 'tools', name: 'Tools and accounts' },
  { key: 'lessons', name: 'Lessons' },
  { key: 'inbox', name: 'Inbox' },
];

/** Hard caps for the graph (docs/14 §16). */
export const GRAPH_MAX_NODES = 150;
export const GRAPH_MAX_EDGES = 400;

/** Seeds the default categories once per workspace (idempotent; never renames user changes). */
export async function ensureCategories(q: Q, orgId: string, workspaceId: string, by: string) {
  const n = await q.one<{ n: number }>('select count(*)::int as n from knowledge_categories where workspace_id=$1', [workspaceId]);
  if ((n?.n ?? 0) > 0) return;
  for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
    await q.exec(
      `insert into knowledge_categories (org_id, workspace_id, key, name, template_key, sort, created_by) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (org_id, workspace_id, key) do nothing`,
      [orgId, workspaceId, c.key, c.name, CATEGORY_TEMPLATE, i, by],
    );
  }
}

export async function categoryByKey(q: Q, workspaceId: string, key: string) {
  return q.one<{ id: string; name: string }>('select id, name from knowledge_categories where workspace_id=$1 and key=$2 and archived_at is null', [workspaceId, key]);
}

const ENTRY_COLS = `m.id, coalesce(m.title, left(m.content, 80)) as title, coalesce(m.body, m.content) as body, m.kind, m.category_id, k.name as category,
  k.key as category_key, m.tags, m.visibility, m.owner_user_id, m.pinned, m.revision, m.status, m.source_kind, m.source_ref, m.confidence,
  m.created_by, m.created_at, m.updated_at, m.last_used_at`;

/** Ranked full-text search over the entries the caller can see (RLS filters the rest). */
export async function searchEntries(q: Q, opts: { q?: string | null; categoryId?: string | null; status?: string | null; limit?: number; offset?: number }) {
  const text = opts.q?.trim() || null;
  return q.many(
    `select ${ENTRY_COLS}, case when $1::text is null then 0 else ts_rank_cd(m.search, websearch_to_tsquery('simple', $1)) end as score
       from memory_records m left join knowledge_categories k on k.id = m.category_id
      where m.deleted_at is null and m.status not in ('archived','superseded')
        and ($2::uuid is null or m.category_id = $2)
        and ($3::text is null or m.status = $3)
        and ($1::text is null or m.search @@ websearch_to_tsquery('simple', $1) or coalesce(m.title, m.content) ilike '%' || $1 || '%')
      order by m.pinned desc, score desc, m.updated_at desc
      limit $4 offset $5`,
    [text, opts.categoryId ?? null, opts.status ?? null, Math.min(opts.limit ?? 50, 100), opts.offset ?? 0],
  );
}

/** Titles for linked records. Anything the caller can't see comes back as "Not available to you". */
export async function resolveTargets(q: Q, refs: { type: string; id: string }[]) {
  const out = new Map<string, string | null>();
  const by = new Map<string, string[]>();
  for (const r of refs) by.set(r.type, [...(by.get(r.type) ?? []), r.id]);
  const sql: Record<string, string> = {
    entry: `select id, coalesce(title, left(content, 80)) as t from memory_records where id = any($1::uuid[]) and deleted_at is null`,
    document: `select id, title as t from documents where id = any($1::uuid[]) and deleted_at is null`,
    contact: `select id, name as t from contacts where id = any($1::uuid[]) and deleted_at is null`,
    company: `select id, name as t from companies where id = any($1::uuid[]) and deleted_at is null`,
    project: `select id, name as t from projects where id = any($1::uuid[])`,
    task: `select id, title as t from tasks where id = any($1::uuid[]) and deleted_at is null`,
  };
  for (const [type, ids] of by) {
    if (!sql[type]) continue;
    for (const row of await q.many(sql[type]!, [[...new Set(ids)]])) out.set(`${type}:${row.id}`, row.t);
  }
  return (type: string, id: string) => out.get(`${type}:${id}`) ?? null;
}

/** Creates a link after checking that the target exists and is visible to the caller. */
export async function createLink(
  q: Q,
  t: { orgId: string; actor: string },
  input: { fromEntry: string; toType: TargetType; toId: string; relation: (typeof RELATIONS)[number]; sourceKind: 'user' | 'agent_inferred' },
) {
  const from = await q.one('select id, visibility from memory_records where id=$1 and deleted_at is null', [input.fromEntry]);
  if (!from) throw notFound('Entry');
  if (input.toType === 'entry' && input.toId === input.fromEntry) throw badRequest('An entry cannot link to itself.');
  const title = (await resolveTargets(q, [{ type: input.toType, id: input.toId }]))(input.toType, input.toId);
  if (title === null) throw notFound('Link target');
  if (input.toType === 'entry' && from.visibility === 'workspace') {
    const target = await q.one('select visibility from memory_records where id=$1', [input.toId]);
    if (target?.visibility === 'private') throw new ApiError(409, 'PRIVATE_TARGET', 'Share the other entry first', 'A shared entry cannot point at a private one, or others would learn it exists.');
  }
  const row = await q.one(
    `insert into knowledge_links (org_id, from_entry, to_type, to_id, relation, source_kind, created_by) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (org_id, from_entry, to_type, to_id, relation) do update set relation = excluded.relation returning *`,
    [t.orgId, input.fromEntry, input.toType, input.toId, input.relation, input.sourceKind, t.actor],
  );
  return { ...row, title };
}

async function writeRevision(q: Q, orgId: string, e: any, change: string, by: string) {
  await q.exec(
    `insert into knowledge_revisions (org_id, entry_id, revision, title, body, category_id, visibility, change_kind, changed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict do nothing`,
    [orgId, e.id, e.revision, e.title, e.body ?? e.content, e.category_id, e.visibility, change, by],
  );
}

export interface GraphNode {
  id: string; // "<type>:<uuid>" or "category:<uuid>"
  type: 'category' | TargetType;
  label: string;
  category?: string | null;
  kind?: string;
  visibility?: string;
  status?: string;
  weight: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  relation: string; // 'in' = entry belongs to a category
  aiAdded?: boolean;
}

/**
 * Graph for the map. Overview: categories, the most relevant entries (pinned and recent first) and the
 * records they link to. Ego: one entry or record at the centre with its neighbours up to 2 hops.
 * Everything goes through RLS-filtered queries; counts include only what the caller can see.
 */
export async function buildGraph(q: Q, opts: { view: 'overview' | 'ego'; focus?: { type: string; id: string }; depth?: 1 | 2; categoryId?: string | null }) {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  let truncated = false;
  const addNode = (n: GraphNode) => {
    if (nodes.has(n.id)) return true;
    if (nodes.size >= GRAPH_MAX_NODES) {
      truncated = true;
      return false;
    }
    nodes.set(n.id, n);
    return true;
  };
  const addEdge = (e: GraphEdge) => {
    const k = `${e.from}|${e.to}|${e.relation}`;
    if (edgeKeys.has(k) || !nodes.has(e.from) || !nodes.has(e.to)) return;
    if (edges.length >= GRAPH_MAX_EDGES) {
      truncated = true;
      return;
    }
    edgeKeys.add(k);
    edges.push(e);
  };
  const entryNode = (r: any): GraphNode => ({ id: `entry:${r.id}`, type: 'entry', label: r.title, category: r.category_id, kind: r.kind, visibility: r.visibility, status: r.status, weight: 1 + (r.pinned ? 1 : 0) });

  const cats = await q.many(
    `select k.id, k.name, (select count(*)::int from memory_records m where m.category_id = k.id and m.deleted_at is null and m.status not in ('archived','superseded')) as n
       from knowledge_categories k where k.archived_at is null order by k.sort, k.name`,
  );
  const catName = new Map(cats.map((c: any) => [c.id, c.name]));

  let entries: any[] = [];
  if (opts.view === 'overview') {
    for (const c of cats) if (c.n > 0 && (!opts.categoryId || c.id === opts.categoryId)) addNode({ id: `category:${c.id}`, type: 'category', label: c.name, weight: c.n });
    entries = await q.many(
      `select m.id, coalesce(m.title, left(m.content, 80)) as title, m.kind, m.category_id, m.visibility, m.status, m.pinned from memory_records m
        where m.deleted_at is null and m.status not in ('archived','superseded') and ($1::uuid is null or m.category_id = $1)
        order by m.pinned desc, m.last_used_at desc nulls last, m.updated_at desc limit $2`,
      [opts.categoryId ?? null, Math.floor(GRAPH_MAX_NODES * 0.6)],
    );
    for (const e of entries) if (addNode(entryNode(e)) && e.category_id && nodes.has(`category:${e.category_id}`)) addEdge({ from: `entry:${e.id}`, to: `category:${e.category_id}`, relation: 'in' });
  } else {
    const f = opts.focus!;
    if (f.type === 'entry') {
      const e = await q.one(`select m.id, coalesce(m.title, left(m.content, 80)) as title, m.kind, m.category_id, m.visibility, m.status, m.pinned from memory_records m where m.id=$1 and m.deleted_at is null`, [f.id]);
      if (!e) throw notFound('Entry');
      addNode(entryNode(e));
      entries = [e];
    } else {
      const title = (await resolveTargets(q, [f]))(f.type, f.id);
      if (title === null) throw notFound('Record');
      addNode({ id: `${f.type}:${f.id}`, type: f.type as TargetType, label: title, weight: 2 });
    }
  }

  // Expand links: overview = 1 hop from the listed entries; ego = depth 1 or 2 from the focus.
  let frontier = new Set<string>(nodes.keys());
  const hops = opts.view === 'overview' ? 1 : (opts.depth ?? 1);
  for (let hop = 0; hop < hops && frontier.size; hop++) {
    const entryIds = [...frontier].filter((k) => k.startsWith('entry:')).map((k) => k.slice(6));
    const recordRefs = [...frontier].filter((k) => !k.startsWith('entry:') && !k.startsWith('category:')).map((k) => ({ type: k.split(':')[0]!, id: k.split(':')[1]! }));
    const links = await q.many(
      `select l.from_entry, l.to_type, l.to_id, l.relation, l.source_kind from knowledge_links l
        where l.from_entry = any($1::uuid[])
           or (l.to_type = 'entry' and l.to_id = any($1::uuid[]))
           or (l.to_type || ':' || l.to_id::text) = any($2::text[])
        limit $3`,
      [entryIds, recordRefs.map((r) => `${r.type}:${r.id}`), GRAPH_MAX_EDGES],
    );
    const needEntries = new Set<string>();
    const needRecords: { type: string; id: string }[] = [];
    for (const l of links) {
      if (!nodes.has(`entry:${l.from_entry}`)) needEntries.add(l.from_entry);
      if (l.to_type === 'entry') {
        if (!nodes.has(`entry:${l.to_id}`)) needEntries.add(l.to_id);
      } else if (!nodes.has(`${l.to_type}:${l.to_id}`)) needRecords.push({ type: l.to_type, id: l.to_id });
    }
    const next = new Set<string>();
    if (needEntries.size) {
      const rows = await q.many(
        `select m.id, coalesce(m.title, left(m.content, 80)) as title, m.kind, m.category_id, m.visibility, m.status, m.pinned from memory_records m where m.id = any($1::uuid[]) and m.deleted_at is null`,
        [[...needEntries]],
      );
      for (const r of rows) if (addNode(entryNode(r))) next.add(`entry:${r.id}`);
    }
    if (needRecords.length) {
      const title = await resolveTargets(q, needRecords);
      for (const r of needRecords) {
        const t = title(r.type, r.id);
        if (t !== null && addNode({ id: `${r.type}:${r.id}`, type: r.type as TargetType, label: t, weight: 1 })) next.add(`${r.type}:${r.id}`);
      }
    }
    for (const l of links) addEdge({ from: `entry:${l.from_entry}`, to: `${l.to_type}:${l.to_id}`, relation: l.relation, aiAdded: l.source_kind === 'agent_inferred' });
    frontier = next;
  }
  for (const n of nodes.values()) if (n.type === 'entry' && n.category) n.category = catName.get(n.category) ?? null;
  return { view: opts.view, nodes: [...nodes.values()], edges, truncated, caps: { nodes: GRAPH_MAX_NODES, edges: GRAPH_MAX_EDGES } };
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------
export const knowledgeRoutes = new Hono<Env>();

const entryInput = z.object({
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(4000).default(''),
  kind: z.enum(KNOWLEDGE_KINDS).default('fact'),
  categoryId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  visibility: z.enum(['private', 'workspace']).default('private'),
  pinned: z.boolean().optional(),
});

knowledgeRoutes.get('/knowledge/categories', async (c) => {
  const t = need(c, 'memory.read');
  const items = await tx(t, async (q) => {
    await ensureCategories(q, t.orgId, t.workspaceId, `user:${t.userId}`);
    return q.many(
      `select k.id, k.key, k.name, k.parent_id, k.sort, k.customized_at,
        (select count(*)::int from memory_records m where m.category_id = k.id and m.deleted_at is null and m.status not in ('archived','superseded')) as count
         from knowledge_categories k where k.archived_at is null order by k.sort, k.name`,
    );
  });
  const unfiled = await tx(t, (q) => q.one<{ n: number }>(`select count(*)::int as n from memory_records where category_id is null and deleted_at is null and status not in ('archived','superseded')`));
  return c.json({ items, unfiled: unfiled?.n ?? 0, canOrganize: ['owner', 'admin', 'manager'].includes(t.role) });
});

knowledgeRoutes.post('/knowledge/categories', async (c) => {
  const t = need(c, 'knowledge.organize');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
  const row = await tx(t, async (q) => {
    await ensureCategories(q, t.orgId, t.workspaceId, `user:${t.userId}`);
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'category';
    const r = await q.one(
      `insert into knowledge_categories (org_id, workspace_id, key, name, sort, created_by)
       values ($1,$2,$3,$4,(select coalesce(max(sort),0)+1 from knowledge_categories where workspace_id=$2),$5)
       on conflict (org_id, workspace_id, key) do nothing returning *`,
      [t.orgId, t.workspaceId, `u_${slug}`, input.name, `user:${t.userId}`],
    );
    if (!r) throw new ApiError(409, 'CATEGORY_EXISTS', 'That category already exists');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.category.created', targetRef: `knowledge_category:${r.id}` });
    return r;
  });
  return c.json(row, 201);
});

knowledgeRoutes.patch('/knowledge/categories/:id', async (c) => {
  const t = need(c, 'knowledge.organize');
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(60).optional(), archived: z.boolean().optional() }));
  const row = await tx(t, async (q) => {
    const cur = await q.one('select * from knowledge_categories where id=$1', [c.req.param('id')]);
    if (!cur) throw notFound('Category');
    if (input.archived && cur.key === 'inbox') throw badRequest('Inbox cannot be archived.');
    const r = await q.one(
      `update knowledge_categories set name=coalesce($2,name), customized_at=case when $2::text is not null then now() else customized_at end,
         archived_at=case when $3::boolean is true then now() when $3::boolean is false then null else archived_at end where id=$1 returning *`,
      [cur.id, input.name ?? null, input.archived ?? null],
    );
    if (input.archived) {
      // Archiving never deletes entries: they move to Inbox (docs/14 §4.2).
      const inbox = await categoryByKey(q, t.workspaceId, 'inbox');
      await q.exec('update memory_records set category_id=$2, updated_at=now() where category_id=$1', [cur.id, inbox?.id ?? null]);
    }
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: input.archived ? 'knowledge.category.archived' : 'knowledge.category.updated', targetRef: `knowledge_category:${cur.id}` });
    return r;
  });
  return c.json(row);
});

knowledgeRoutes.get('/knowledge/entries', async (c) => {
  const t = need(c, 'memory.read');
  const p = query(c, z.object({ q: z.string().max(200).optional(), category: z.string().uuid().optional(), status: z.enum(['active', 'proposed']).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(10000).default(0) }));
  const items = await tx(t, (q) => searchEntries(q, { q: p.q, categoryId: p.category, status: p.status, limit: p.limit, offset: p.offset }));
  return c.json({ items: items.map((e: any) => ({ ...e, mine: e.owner_user_id === t.userId || e.created_by === `user:${t.userId}` })) });
});

knowledgeRoutes.get('/knowledge/entries/:id', async (c) => {
  const t = need(c, 'memory.read');
  const out = await tx(t, async (q) => {
    const e = await q.one(`select ${ENTRY_COLS} from memory_records m left join knowledge_categories k on k.id = m.category_id where m.id=$1 and m.deleted_at is null`, [c.req.param('id')]);
    if (!e) throw notFound('Entry');
    const out = await q.many(`select id, to_type, to_id, relation, source_kind, created_at from knowledge_links where from_entry=$1 order by created_at`, [e.id]);
    const inbound = await q.many(`select id, from_entry, relation, source_kind, created_at from knowledge_links where to_type='entry' and to_id=$1 order by created_at`, [e.id]);
    const title = await resolveTargets(q, [...out.map((l: any) => ({ type: l.to_type, id: l.to_id })), ...inbound.map((l: any) => ({ type: 'entry', id: l.from_entry }))]);
    const revisions = await q.many(`select revision, title, change_kind, changed_by, changed_at from knowledge_revisions where entry_id=$1 order by revision desc limit 5`, [e.id]);
    return {
      ...e,
      mine: e.owner_user_id === t.userId || e.created_by === `user:${t.userId}`,
      links: [
        ...out.map((l: any) => ({ id: l.id, direction: 'out', type: l.to_type, targetId: l.to_id, relation: l.relation, aiAdded: l.source_kind === 'agent_inferred', title: title(l.to_type, l.to_id) ?? 'Not available to you' })),
        ...inbound.map((l: any) => ({ id: l.id, direction: 'in', type: 'entry', targetId: l.from_entry, relation: l.relation, aiAdded: l.source_kind === 'agent_inferred', title: title('entry', l.from_entry) ?? 'Not available to you' })),
      ],
      revisions,
    };
  });
  return c.json(out);
});

knowledgeRoutes.post('/knowledge/entries', async (c) => {
  const t = need(c, 'memory.write');
  const input = await body(c, entryInput);
  const row = await tx(t, async (q) => {
    await ensureCategories(q, t.orgId, t.workspaceId, `user:${t.userId}`);
    const cat = input.categoryId ?? (await categoryByKey(q, t.workspaceId, 'inbox'))?.id ?? null;
    const r = await q.one(
      `insert into memory_records (org_id, workspace_id, kind, content, title, body, category_id, tags, visibility, owner_user_id, pinned, source_kind, confidence, status, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'user',1,'active',$12) returning *`,
      [t.orgId, t.workspaceId, input.kind, input.body || input.title, input.title, input.body, cat, input.tags, input.visibility, t.userId, input.pinned ?? false, `user:${t.userId}`],
    );
    await writeRevision(q, t.orgId, r, 'create', `user:${t.userId}`);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.created', targetRef: `memory:${r.id}`, detail: { visibility: r.visibility } });
    return r;
  });
  return c.json(row, 201);
});

knowledgeRoutes.patch('/knowledge/entries/:id', async (c) => {
  const t = need(c, 'memory.write');
  const input = await body(c, entryInput.partial().omit({ visibility: true }).extend({ ifRevision: z.number().int().min(1) }));
  const row = await tx(t, async (q) => {
    const cur = await q.one('select * from memory_records where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!cur) throw notFound('Entry');
    if (cur.revision !== input.ifRevision) throw new ApiError(409, 'REVISION_CONFLICT', 'Someone changed this entry', `It is now at revision ${cur.revision}. Reload and try again.`);
    const title = input.title ?? cur.title;
    const text = input.body ?? cur.body ?? cur.content;
    const r = await q.one(
      `update memory_records set title=$2, body=$3, content=$4, kind=coalesce($5,kind), category_id=coalesce($6,category_id), tags=coalesce($7,tags), pinned=coalesce($8,pinned),
         revision=revision+1, updated_at=now() where id=$1 returning *`,
      [cur.id, title, text, text || title, input.kind ?? null, input.categoryId ?? null, input.tags ?? null, input.pinned ?? null],
    );
    await writeRevision(q, t.orgId, r, 'edit', `user:${t.userId}`);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.edited', targetRef: `memory:${r.id}`, detail: { revision: r.revision } });
    return r;
  });
  return c.json(row);
});

for (const action of ['share', 'unshare'] as const) {
  knowledgeRoutes.post(`/knowledge/entries/:id/${action}`, async (c) => {
    const t = need(c, 'memory.write');
    const row = await tx(t, async (q) => {
      const cur = await q.one('select * from memory_records where id=$1 and deleted_at is null', [c.req.param('id')]);
      if (!cur) throw notFound('Entry');
      const mine = cur.owner_user_id === t.userId || (!cur.owner_user_id && cur.created_by === `user:${t.userId}`);
      // Only the owner shares or unshares; managers+ may unshare entries that have no owner (older rows).
      if (!mine && !(action === 'unshare' && !cur.owner_user_id && ['owner', 'admin', 'manager'].includes(t.role))) throw new ApiError(403, 'FORBIDDEN', 'Only the person who owns this entry can do that');
      if (action === 'share') {
        const priv = await q.one(`select 1 from knowledge_links l join memory_records m on m.id = l.to_id where l.from_entry=$1 and l.to_type='entry' and m.visibility='private'`, [cur.id]);
        if (priv) throw new ApiError(409, 'PRIVATE_TARGET', 'This entry links to a private entry', 'Share that entry too, or remove the link first.');
      }
      const r = await q.one(`update memory_records set visibility=$2, owner_user_id=coalesce(owner_user_id,$3), revision=revision+1, updated_at=now() where id=$1 returning *`, [
        cur.id,
        action === 'share' ? 'workspace' : 'private',
        t.userId,
      ]);
      await writeRevision(q, t.orgId, r, action, `user:${t.userId}`);
      await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: `knowledge.${action}d`, targetRef: `memory:${r.id}` });
      return r;
    });
    return c.json(row);
  });
}

knowledgeRoutes.post('/knowledge/entries/:id/confirm', async (c) => {
  const t = need(c, 'memory.write');
  const row = await tx(t, async (q) => {
    const r = await q.one(`update memory_records set status='active', confidence=1, revision=revision+1, updated_at=now() where id=$1 and status='proposed' and deleted_at is null returning *`, [c.req.param('id')]);
    if (!r) throw notFound('Proposed entry');
    await writeRevision(q, t.orgId, r, 'confirm', `user:${t.userId}`);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.confirmed', targetRef: `memory:${r.id}` });
    return r;
  });
  return c.json(row);
});

knowledgeRoutes.delete('/knowledge/entries/:id', async (c) => {
  const t = need(c, 'memory.write');
  await tx(t, async (q) => {
    const cur = await q.one('select * from memory_records where id=$1 and deleted_at is null', [c.req.param('id')]);
    if (!cur) throw notFound('Entry');
    const mine = cur.owner_user_id === t.userId || cur.created_by === `user:${t.userId}`;
    if (!mine && !['owner', 'admin', 'manager'].includes(t.role)) throw new ApiError(403, 'FORBIDDEN', 'Only the owner or a manager can delete this entry');
    await q.exec(`update memory_records set deleted_at=now(), updated_at=now() where id=$1`, [cur.id]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.deleted', targetRef: `memory:${cur.id}` });
  });
  return c.json({ ok: true });
});

const linkInput = z.object({ fromEntry: z.string().uuid(), toType: z.enum(TARGET_TYPES), toId: z.string().uuid(), relation: z.enum(RELATIONS).default('related_to') });

knowledgeRoutes.post('/knowledge/links', async (c) => {
  const t = need(c, 'memory.write');
  const input = await body(c, linkInput);
  const row = await tx(t, async (q) => {
    const r = await createLink(q, { orgId: t.orgId, actor: `user:${t.userId}` }, { ...input, sourceKind: 'user' });
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.linked', targetRef: `memory:${input.fromEntry}`, detail: { to: `${input.toType}:${input.toId}`, relation: input.relation } });
    return r;
  });
  return c.json(row, 201);
});

knowledgeRoutes.delete('/knowledge/links/:id', async (c) => {
  const t = need(c, 'memory.write');
  await tx(t, async (q) => {
    const n = await q.exec('delete from knowledge_links where id=$1', [c.req.param('id')]);
    if (!n) throw notFound('Link');
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'knowledge.unlinked', targetRef: `knowledge_link:${c.req.param('id')}` });
  });
  return c.json({ ok: true });
});

/** Records an entry can link to, for the "Connect to…" picker. */
knowledgeRoutes.get('/knowledge/targets', async (c) => {
  const t = need(c, 'memory.read');
  const p = query(c, z.object({ q: z.string().trim().min(1).max(100) }));
  const like = `%${p.q}%`;
  const items = await tx(t, async (q) => [
    ...(await q.many(`select 'entry' as type, id, coalesce(title, left(content, 80)) as title from memory_records where deleted_at is null and coalesce(title, content) ilike $1 limit 8`, [like])),
    ...(await q.many(`select 'contact' as type, id, name as title from contacts where deleted_at is null and name ilike $1 limit 6`, [like])),
    ...(await q.many(`select 'company' as type, id, name as title from companies where deleted_at is null and name ilike $1 limit 6`, [like])),
    ...(await q.many(`select 'project' as type, id, name as title from projects where name ilike $1 limit 6`, [like])),
    ...(await q.many(`select 'task' as type, id, title from tasks where deleted_at is null and title ilike $1 limit 6`, [like])),
    ...(await q.many(`select 'document' as type, id, title from documents where deleted_at is null and title ilike $1 limit 6`, [like])),
  ]);
  return c.json({ items });
});

knowledgeRoutes.get('/knowledge/graph', async (c) => {
  const t = need(c, 'memory.read');
  const p = query(
    c,
    z.object({
      view: z.enum(['overview', 'ego']).default('overview'),
      focus: z.string().regex(/^(entry|document|contact|company|project|task):[0-9a-f-]{36}$/i).optional(),
      depth: z.coerce.number().int().min(1).max(2).default(1),
      category: z.string().uuid().optional(),
    }),
  );
  if (p.view === 'ego' && !p.focus) throw badRequest('Ego view needs focus=<type>:<id>.');
  const focus = p.focus ? { type: p.focus.split(':')[0]!, id: p.focus.split(':')[1]! } : undefined;
  const g = await tx(t, async (q) => {
    await ensureCategories(q, t.orgId, t.workspaceId, `user:${t.userId}`);
    return buildGraph(q, { view: p.view, focus, depth: p.depth as 1 | 2, categoryId: p.category });
  });
  return c.json(g);
});
