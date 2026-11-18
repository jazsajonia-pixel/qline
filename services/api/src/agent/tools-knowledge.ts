import { z } from 'zod';
import { audit } from '../core/audit';
import { categoryByKey, createLink, DEFAULT_CATEGORIES, ensureCategories, KNOWLEDGE_KINDS, RELATIONS, searchEntries, TARGET_TYPES } from '../modules/knowledge';
import { fail } from './tools-apps';
import type { ToolDef } from './tools';

/**
 * v1.6 run 3 Knowledge OS tools. The database decides what the agent can see: private entries
 * are only visible during the owner's own chat turn (qline.run_kind = 'interactive').
 * Anything the agent writes is a *proposal* that a person confirms in the Library.
 */

const CATEGORY_KEYS = DEFAULT_CATEGORIES.map((c) => c.key) as [string, ...string[]];

export const knowledgeTools = {
  'knowledge.search': {
    description:
      'Search the business knowledge base (facts, policies, processes, decisions, lessons). Use before answering questions about how the business works. Returns title, category and a short excerpt. Entries marked status "proposed" are unconfirmed.',
    schema: z.object({ query: z.string().trim().min(1).max(200), category: z.enum(CATEGORY_KEYS).optional(), limit: z.number().int().min(1).max(15).optional() }),
    async execute(q, ctx, a) {
      const cat = a.category ? await categoryByKey(q, ctx.workspaceId, a.category) : null;
      const rows = await searchEntries(q, { q: a.query, categoryId: cat?.id ?? null, limit: a.limit ?? 8 });
      if (rows.length) await q.exec('update memory_records set last_used_at=now() where id = any($1::uuid[])', [rows.map((r: any) => r.id)]);
      return {
        ok: true,
        summary: `${rows.length} knowledge entr${rows.length === 1 ? 'y' : 'ies'} found`,
        refs: rows.map((r: any) => ({ type: 'memory', id: r.id, title: r.title })),
        data: rows.map((r: any) => ({ id: r.id, title: r.title, category: r.category, kind: r.kind, status: r.status, private: r.visibility === 'private', excerpt: String(r.body ?? '').slice(0, 600) })),
      };
    },
    preview: (a) => ({ title: 'Search knowledge', lines: [a.query] }),
  } satisfies ToolDef<any>,

  'knowledge.propose': {
    description:
      'Suggest a new knowledge entry (a fact, policy, process, decision or lesson the user told you or that you learned from their data). It is saved as a private, unconfirmed proposal for the user to review; it never becomes shared on its own.',
    schema: z.object({
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(8000),
      kind: z.enum(KNOWLEDGE_KINDS).default('fact'),
      category: z.enum(CATEGORY_KEYS).default('inbox'),
      tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      sourceRef: z.string().trim().max(200).optional().describe('Where this came from, e.g. "file:<id>", "email:<id>", "chat"'),
    }),
    async execute(q, ctx, a) {
      await ensureCategories(q, ctx.orgId, ctx.workspaceId, `${ctx.actor.kind}:${ctx.actor.id}`);
      const cat = (await categoryByKey(q, ctx.workspaceId, a.category)) ?? (await categoryByKey(q, ctx.workspaceId, 'inbox'));
      // In a person's chat turn the proposal is private to them. Background runs cannot create private
      // rows they could not read back, so their proposals are workspace-visible but still unconfirmed.
      const visibility = ctx.interactive ? 'private' : 'workspace';
      const r = await q.one(
        `insert into memory_records (org_id, workspace_id, kind, content, title, body, category_id, tags, visibility, owner_user_id, source_kind, source_ref, confidence, status, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'agent_inferred',$11,0.6,'proposed',$12) returning id, title, revision, category_id, visibility, body`,
        [ctx.orgId, ctx.workspaceId, a.kind, a.body, a.title, a.body, cat?.id ?? null, a.tags ?? [], visibility, ctx.userId, a.sourceRef ?? 'chat', `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await q.exec(
        `insert into knowledge_revisions (org_id, entry_id, revision, title, body, category_id, visibility, change_kind, changed_by) values ($1,$2,1,$3,$4,$5,$6,'create',$7) on conflict do nothing`,
        [ctx.orgId, r.id, r.title, r.body, r.category_id, r.visibility, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'knowledge.proposed', targetRef: `memory:${r.id}`, detail: { visibility } });
      return { ok: true, summary: `Suggested “${r.title}” for the knowledge base (waiting for review in Library → Knowledge)`, refs: [{ type: 'memory', id: r.id, title: r.title }] };
    },
    preview: (a) => ({ title: 'Suggest a knowledge entry', lines: [a.title, `Category: ${a.category ?? 'inbox'}`] }),
  } satisfies ToolDef<any>,

  'knowledge.link': {
    description:
      'Connect a knowledge entry to something it is about: another entry, a document, contact, company, project or task. The link shows as "Added by AI" on the knowledge map and the user can remove it.',
    schema: z.object({
      entryId: z.string().uuid(),
      toType: z.enum(TARGET_TYPES),
      toId: z.string().uuid(),
      relation: z.enum(RELATIONS).default('about'),
    }),
    async execute(q, ctx, a) {
      try {
        const l = await createLink(q, { orgId: ctx.orgId, actor: `${ctx.actor.kind}:${ctx.actor.id}` }, { fromEntry: a.entryId, toType: a.toType, toId: a.toId, relation: a.relation, sourceKind: 'agent_inferred' });
        await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'knowledge.linked', targetRef: `memory:${a.entryId}`, detail: { to: `${a.toType}:${a.toId}`, relation: a.relation } });
        return { ok: true, summary: `Linked to ${a.toType} “${l.title}” (${a.relation.replace('_', ' ')})`, refs: [{ type: 'memory', id: a.entryId }] };
      } catch (e) {
        return fail((e as Error).message);
      }
    },
    preview: (a) => ({ title: 'Link knowledge', lines: [`${a.relation} → ${a.toType}`] }),
  } satisfies ToolDef<any>,
};
