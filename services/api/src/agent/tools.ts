import { z } from 'zod';
import type { ToolSpec } from '@qline/ai';
import type { Q } from '../core/db';
import { audit } from '../core/audit';
import { createTask, updateTask } from '../modules/work';
import { appTools } from './tools-apps';
import { moreTools } from './tools-more';
import { v16Tools } from './tools-v16';
import { fileTools } from './tools-files';
import { knowledgeTools } from './tools-knowledge';
import { connectorTools } from './tools-connectors';
import { proposalTools } from './tools-proposals';

export interface ToolCtx {
  orgId: string;
  workspaceId: string;
  /** Who is acting: the agent (chat) or workflow, on behalf of `userId`. */
  actor: { kind: 'agent' | 'workflow'; id: string };
  userId: string;
  /** True only for a person's own chat turn. Private knowledge is only reachable then. */
  interactive?: boolean;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  refs: { type: string; id: string; title?: string }[];
  data?: unknown;
  /** v1.6: things to show in the chat (charts, images). Not sent back to the model. */
  artifacts?: Artifact[];
}

/** v1.6 chat artifacts. Charts carry their data and where it came from; images point at a stored file. */
export type Artifact =
  | {
      type: 'chart';
      chart: 'bar' | 'line' | 'pie';
      title: string;
      labels: string[];
      series: { name: string; values: number[] }[];
      unit?: string;
      source: string;
      computed: boolean;
    }
  | { type: 'image'; fileId: string; name: string; caption?: string }
  | { type: 'file'; fileId: string; name: string; kind: string; size: number; source?: string }
  | { type: 'proposal'; id: string; kind: 'mission' | 'agent_change'; title: string };

export interface ToolDef<S extends z.ZodTypeAny> {
  description: string;
  schema: S;
  execute(q: Q, ctx: ToolCtx, args: z.infer<S>): Promise<ToolResult>;
  /** Describe what would happen, without side effects (approvals preview, dry runs). */
  preview(args: z.infer<S>): { title: string; lines: string[] };
}

const dueFromArgs = (a: { dueAt?: string | null; dueInDays?: number | null }) =>
  a.dueAt ?? (a.dueInDays != null ? new Date(Date.now() + a.dueInDays * 86400_000).toISOString() : null);

const defs = {
  'tasks.search': {
    description: 'Search tasks. Use for "what is due", "what is overdue", "what is blocked".',
    schema: z.object({
      query: z.string().max(200).optional(),
      status: z.string().max(40).optional().describe('todo | in_progress | blocked | done | open'),
      dueWithinDays: z.number().int().min(0).max(365).optional(),
      overdueOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async execute(q, _ctx, a) {
      const rows = await q.many(
        `select id, title, status, priority, due_at from tasks where deleted_at is null
         and ($1::text is null or title ilike '%' || $1 || '%')
         and ($2::text is null or ($2 = 'open' and status <> 'done') or status = $2)
         and ($3::int is null or (due_at < now() + make_interval(days => $3) and status <> 'done'))
         and (not $4::boolean or (due_at < now() and status <> 'done'))
         order by due_at nulls last limit $5`,
        [a.query ?? null, a.status ?? null, a.dueWithinDays ?? null, a.overdueOnly ?? false, a.limit ?? 10],
      );
      return { ok: true, summary: `${rows.length} task${rows.length === 1 ? '' : 's'}`, refs: rows.map((r) => ({ type: 'task', id: r.id, title: r.title })), data: rows };
    },
    preview: (a) => ({ title: 'Search tasks', lines: [a.query ?? 'all'] }),
  } satisfies ToolDef<any>,

  'tasks.create': {
    description: 'Create a task. Needs human approval unless the org allows it.',
    schema: z.object({
      title: z.string().trim().min(1).max(300),
      description: z.string().max(2000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueAt: z.string().datetime({ offset: true }).optional().describe('ISO 8601 with timezone'),
      dueInDays: z.number().int().min(0).max(365).optional(),
      projectId: z.string().uuid().optional(),
    }),
    async execute(q, ctx, a) {
      const row = await createTask(
        q,
        ctx,
        ctx.actor,
        { title: a.title, description: a.description ?? null, priority: a.priority, dueAt: dueFromArgs(a), projectId: a.projectId ?? null },
        { kind: ctx.actor.kind === 'agent' ? 'agent_inferred' : 'workflow', ref: `${ctx.actor.kind}:${ctx.actor.id}` },
      );
      return { ok: true, summary: `Created task "${row.title}"`, refs: [{ type: 'task', id: row.id, title: row.title }], data: { id: row.id } };
    },
    preview: (a) => ({
      title: `Create task: ${a.title}`,
      lines: [a.priority ? `Priority: ${a.priority}` : 'Priority: normal', dueFromArgs(a) ? `Due: ${dueFromArgs(a)!.slice(0, 10)}` : 'No due date', ...(a.description ? [a.description] : [])],
    }),
  } satisfies ToolDef<any>,

  'tasks.update': {
    description: 'Update a task status, title, priority or due date.',
    schema: z.object({
      taskId: z.string().uuid(),
      status: z.string().max(40).optional(),
      title: z.string().max(300).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      dueAt: z.string().datetime({ offset: true }).optional(),
    }),
    async execute(q, ctx, a) {
      const row = await updateTask(q, ctx, ctx.actor, a.taskId, { status: a.status, title: a.title, priority: a.priority, dueAt: a.dueAt });
      return { ok: true, summary: `Updated task "${row.title}"`, refs: [{ type: 'task', id: row.id, title: row.title }] };
    },
    preview: (a) => ({ title: 'Update task', lines: Object.entries(a).filter(([k]) => k !== 'taskId').map(([k, v]) => `${k}: ${v}`) }),
  } satisfies ToolDef<any>,

  'records.search': {
    description: 'Search contacts and companies by name or email.',
    schema: z.object({ query: z.string().min(1).max(200) }),
    async execute(q, _ctx, a) {
      const like = `%${a.query}%`;
      const contacts = await q.many(`select id, name, email, stage, title from contacts where deleted_at is null and (name ilike $1 or email ilike $1) limit 10`, [like]);
      const companies = await q.many(`select id, name, domain from companies where deleted_at is null and name ilike $1 limit 10`, [like]);
      return {
        ok: true,
        summary: `${contacts.length} contacts, ${companies.length} companies`,
        refs: [...contacts.map((r) => ({ type: 'contact', id: r.id, title: r.name })), ...companies.map((r) => ({ type: 'company', id: r.id, title: r.name }))],
        data: { contacts, companies },
      };
    },
    preview: (a) => ({ title: 'Search records', lines: [a.query] }),
  } satisfies ToolDef<any>,

  'documents.search': {
    description: 'Full-text search the business library (documents, notes, imported files).',
    schema: z.object({ query: z.string().min(1).max(200) }),
    async execute(q, _ctx, a) {
      const rows = await q.many(
        `select id, title, left(body, 1200) as excerpt from documents where deleted_at is null
         and (search @@ websearch_to_tsquery('simple', $1) or title ilike '%' || $1 || '%')
         order by ts_rank(search, websearch_to_tsquery('simple', $1)) desc limit 5`,
        [a.query],
      );
      return { ok: true, summary: `${rows.length} documents`, refs: rows.map((r) => ({ type: 'document', id: r.id, title: r.title })), data: rows };
    },
    preview: (a) => ({ title: 'Search library', lines: [a.query] }),
  } satisfies ToolDef<any>,

  'memory.read': {
    description: 'Read confirmed business memory (facts, preferences, policies).',
    schema: z.object({ query: z.string().max(200).optional() }),
    async execute(q, _ctx, a) {
      const rows = await q.many(
        `select id, kind, content, source_kind, confidence from memory_records where status='active' and deleted_at is null and ($1::text is null or content ilike '%' || $1 || '%') order by updated_at desc limit 20`,
        [a.query ?? null],
      );
      return { ok: true, summary: `${rows.length} memories`, refs: rows.map((r) => ({ type: 'memory', id: r.id })), data: rows };
    },
    preview: () => ({ title: 'Read memory', lines: [] }),
  } satisfies ToolDef<any>,

  'memory.propose': {
    description: 'Propose a new memory. It is stored as "Inferred" until a human confirms it.',
    schema: z.object({ content: z.string().trim().min(1).max(1000), kind: z.enum(['fact', 'preference', 'policy', 'context']).optional() }),
    async execute(q, ctx, a) {
      const r = await q.one(
        `insert into memory_records (org_id, workspace_id, kind, content, source_kind, source_ref, confidence, status, created_by)
         values ($1,$2,$3,$4,'agent_inferred',$5,0.6,'proposed',$5) returning id`,
        [ctx.orgId, ctx.workspaceId, a.kind ?? 'fact', a.content, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'memory.proposed', targetRef: `memory:${r.id}` });
      return { ok: true, summary: 'Proposed a memory (needs your confirmation)', refs: [{ type: 'memory', id: r.id }] };
    },
    preview: (a) => ({ title: 'Propose memory', lines: [a.content] }),
  } satisfies ToolDef<any>,

  'notes.create': {
    description: 'Save a note to the library.',
    schema: z.object({ title: z.string().trim().min(1).max(300), body: z.string().max(20000) }),
    async execute(q, ctx, a) {
      const r = await q.one(
        `insert into documents (org_id, workspace_id, kind, title, body, folder, source_kind, source_ref, created_by) values ($1,$2,'note',$3,$4,'Notes','agent_inferred',$5,$5) returning id`,
        [ctx.orgId, ctx.workspaceId, a.title, a.body, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'note.created', targetRef: `document:${r.id}` });
      return { ok: true, summary: `Saved note "${a.title}"`, refs: [{ type: 'document', id: r.id, title: a.title }] };
    },
    preview: (a) => ({ title: `Save note: ${a.title}`, lines: [a.body.slice(0, 200)] }),
  } satisfies ToolDef<any>,

  'contacts.update': {
    description: 'Update a contact stage, title, phone or notes.',
    schema: z.object({ contactId: z.string().uuid(), stage: z.string().max(60).optional(), title: z.string().max(200).optional(), phone: z.string().max(60).optional(), notes: z.string().max(5000).optional() }),
    async execute(q, ctx, a) {
      const r = await q.one(
        `update contacts set stage=coalesce($2,stage), title=coalesce($3,title), phone=coalesce($4,phone), notes=coalesce($5,notes), updated_at=now() where id=$1 and deleted_at is null returning id, name`,
        [a.contactId, a.stage ?? null, a.title ?? null, a.phone ?? null, a.notes ?? null],
      );
      if (!r) return { ok: false, summary: 'Contact not found', refs: [] };
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'contact.updated', targetRef: `contact:${r.id}` });
      return { ok: true, summary: `Updated ${r.name}`, refs: [{ type: 'contact', id: r.id, title: r.name }] };
    },
    preview: (a) => ({ title: 'Update contact', lines: Object.entries(a).filter(([k]) => k !== 'contactId').map(([k, v]) => `${k}: ${v}`) }),
  } satisfies ToolDef<any>,

  'drafts.email.create': {
    description: 'Write an email DRAFT and save it in the library. It is never sent.',
    schema: z.object({ to: z.string().max(320), subject: z.string().max(300), body: z.string().max(20000) }),
    async execute(q, ctx, a) {
      const r = await q.one(
        `insert into documents (org_id, workspace_id, kind, title, body, folder, source_kind, source_ref, created_by) values ($1,$2,'draft_email',$3,$4,'Drafts','agent_inferred',$5,$5) returning id`,
        [ctx.orgId, ctx.workspaceId, a.subject, `To: ${a.to}\n\n${a.body}`, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'draft.created', targetRef: `document:${r.id}` });
      return { ok: true, summary: `Saved draft "${a.subject}" (not sent)`, refs: [{ type: 'document', id: r.id, title: a.subject }] };
    },
    preview: (a) => ({ title: `Draft email: ${a.subject}`, lines: [`To: ${a.to}`, a.body.slice(0, 200)] }),
  } satisfies ToolDef<any>,

  ...appTools,
  ...moreTools,
  ...v16Tools,
  ...fileTools,
  ...knowledgeTools,
  ...connectorTools,
  ...proposalTools,
};

export type ToolName = keyof typeof defs;
export const IMPLEMENTED_TOOLS = Object.keys(defs) as ToolName[];

export function getTool(name: string): ToolDef<z.ZodTypeAny> | null {
  return (defs as Record<string, ToolDef<z.ZodTypeAny>>)[name] ?? null;
}

/** Model-facing names cannot contain dots for some providers. */
export const toModelName = (n: string) => n.replace(/\./g, '__');
export const fromModelName = (n: string) => n.replace(/__/g, '.');

export function toolSpecs(allow: readonly string[]): ToolSpec[] {
  return IMPLEMENTED_TOOLS.filter((n) => allow.includes(n)).map((n) => {
    const d = getTool(n)!;
    const schema = z.toJSONSchema(d.schema) as Record<string, unknown>;
    delete schema.$schema;
    return { name: toModelName(n), description: d.description, parameters: schema };
  });
}
