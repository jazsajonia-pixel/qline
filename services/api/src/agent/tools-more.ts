import { z } from 'zod';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { accessToken, api, hasScope } from '../integrations/oauth';
import { slackChannels } from '../integrations/services';
import type { ToolDef, ToolResult } from './tools';

/**
 * v1.5 assistant tools: more of Qline's own data (documents, contacts, companies, projects, comments,
 * a business snapshot), Google Sheets read/append for sheets Qline created, and Slack channel lookup.
 * They reuse existing connections and scopes; nothing here needs a new Google or Slack permission.
 */

const fail = (summary: string): ToolResult => ({ ok: false, summary, refs: [] });

async function conn(q: Q, provider: 'google' | 'slack', scope?: string): Promise<{ conn: any; token: string } | string> {
  const name = provider === 'google' ? 'Google' : 'Slack';
  const rows = await q.many(`select * from integration_connections where provider=$1 and status='ok'`, [provider]);
  const c = rows.find((r: any) => !scope || hasScope(r, scope));
  if (!c) return rows.length ? `${name} is connected without the permission this needs. Reconnect it in Settings → Integrations.` : `${name} is not connected. Connect it in Settings → Integrations first.`;
  try {
    return { conn: c, token: await accessToken(q, c) };
  } catch (e) {
    return (e as Error).message;
  }
}

/** Google Sheets ids are [A-Za-z0-9_-]; accept a full sheet URL too. */
export function sheetId(input: string): string | null {
  const m = input.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/) ?? input.match(/^([A-Za-z0-9_-]{20,})$/);
  return m ? m[1]! : null;
}

/** Slack channel names: lowercase, no '#'. */
export const slackName = (s: string) => s.trim().replace(/^#/, '').toLowerCase();

export const moreTools = {
  'time.now': {
    description: 'Get the current date and time (and weekday). Use before working out "today", "tomorrow", "next Monday" or due dates.',
    schema: z.object({ timeZone: z.string().max(60).optional().describe('IANA zone, e.g. Asia/Manila. Defaults to the business timezone, else UTC.') }),
    async execute(q, _ctx, a) {
      const prof = await q.one(`select profile->>'timezone' as tz from business_profiles limit 1`).catch(() => null);
      let tz = a.timeZone || prof?.tz || 'UTC';
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
      } catch {
        tz = 'UTC';
      }
      const now = new Date();
      const local = new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
      return { ok: true, summary: `${local} (${tz})`, refs: [], data: { iso: now.toISOString(), timeZone: tz, local } };
    },
    preview: () => ({ title: 'Check the time', lines: [] }),
  } satisfies ToolDef<any>,

  'documents.read': {
    description: 'Read one library document, note or draft in full (use an id from documents.search).',
    schema: z.object({ documentId: z.string().uuid() }),
    async execute(q, _ctx, a) {
      const d = await q.one(`select id, kind, title, left(body, 12000) as body, folder, source_kind, updated_at from documents where id=$1 and deleted_at is null`, [a.documentId]);
      if (!d) return fail('Document not found');
      return { ok: true, summary: `Read “${String(d.title).slice(0, 80)}”`, refs: [{ type: 'document', id: d.id, title: d.title }], data: d };
    },
    preview: (a) => ({ title: 'Read document', lines: [a.documentId] }),
  } satisfies ToolDef<any>,

  'contacts.get': {
    description: 'Get one contact in full: details, company, open tasks that mention them and their recent leads.',
    schema: z.object({ contactId: z.string().uuid() }),
    async execute(q, _ctx, a) {
      const c = await q.one(
        `select c.id, c.name, c.email, c.phone, c.title, c.stage, c.notes, c.created_at, co.id as company_id, co.name as company
           from contacts c left join companies co on co.id=c.company_id and co.deleted_at is null
          where c.id=$1 and c.deleted_at is null`,
        [a.contactId],
      );
      if (!c) return fail('Contact not found');
      const [tasks, leads] = await Promise.all([
        q.many(`select id, title, status, due_at from tasks where deleted_at is null and status <> 'done' and (title ilike '%' || $1 || '%' or description ilike '%' || $1 || '%') order by due_at nulls last limit 10`, [c.name]),
        q.many(`select id, source, subject, summary, urgency, received_at from lead_inbox where contact_id=$1 order by received_at desc limit 5`, [c.id]),
      ]);
      return { ok: true, summary: `${c.name}${c.company ? ` · ${c.company}` : ''}`, refs: [{ type: 'contact', id: c.id, title: c.name }, ...tasks.map((t: any) => ({ type: 'task', id: t.id, title: t.title }))], data: { ...c, openTasks: tasks, recentLeads: leads } };
    },
    preview: (a) => ({ title: 'Look up contact', lines: [a.contactId] }),
  } satisfies ToolDef<any>,

  'companies.create': {
    description: 'Add a company (organization) to the CRM.',
    schema: z.object({ name: z.string().trim().min(1).max(200), domain: z.string().trim().max(200).optional(), notes: z.string().max(4000).optional() }),
    async execute(q, ctx, a) {
      const domain = a.domain ? a.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() : null;
      const dup = await q.one(`select id, name from companies where deleted_at is null and (lower(name)=lower($1) or ($2::text is not null and lower(domain)=$2)) limit 1`, [a.name, domain]);
      if (dup) return { ok: true, summary: `${dup.name} is already in the CRM`, refs: [{ type: 'company', id: dup.id, title: dup.name }] };
      const r = await q.one(
        `insert into companies (org_id, workspace_id, name, domain, notes, source_kind, source_ref, created_by) values ($1,$2,$3,$4,$5,'agent_inferred',$6,$6) returning id, name`,
        [ctx.orgId, ctx.workspaceId, a.name, domain, a.notes ?? null, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'company.created', targetRef: `company:${r.id}`, detail: { name: r.name } });
      return { ok: true, summary: `Added company ${r.name}`, refs: [{ type: 'company', id: r.id, title: r.name }] };
    },
    preview: (a) => ({ title: `Add company: ${a.name}`, lines: [a.domain, a.notes?.slice(0, 200)].filter(Boolean) as string[] }),
  } satisfies ToolDef<any>,

  'projects.list': {
    description: 'List projects with their status and how many open and overdue tasks each has.',
    schema: z.object({ status: z.enum(['active', 'on_hold', 'done', 'archived', 'all']).default('active') }),
    async execute(q, _ctx, a) {
      const rows = await q.many(
        `select p.id, p.name, p.status, p.description,
                count(t.id) filter (where t.status <> 'done') as open_tasks,
                count(t.id) filter (where t.status <> 'done' and t.due_at < now()) as overdue_tasks
           from projects p left join tasks t on t.project_id=p.id and t.deleted_at is null
          where ($1 = 'all' or p.status = $1) group by p.id order by p.updated_at desc limit 30`,
        [a.status],
      );
      return { ok: true, summary: `${rows.length} project${rows.length === 1 ? '' : 's'}`, refs: rows.map((r: any) => ({ type: 'project', id: r.id, title: r.name })), data: rows };
    },
    preview: () => ({ title: 'List projects', lines: [] }),
  } satisfies ToolDef<any>,

  'projects.create': {
    description: 'Create a project to group related tasks.',
    schema: z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional() }),
    async execute(q, ctx, a) {
      const r = await q.one(
        `insert into projects (org_id, workspace_id, name, description, created_by) values ($1,$2,$3,$4,$5) returning id, name`,
        [ctx.orgId, ctx.workspaceId, a.name, a.description ?? null, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'project.created', targetRef: `project:${r.id}`, detail: { name: r.name } });
      return { ok: true, summary: `Created project “${r.name}”`, refs: [{ type: 'project', id: r.id, title: r.name }] };
    },
    preview: (a) => ({ title: `Create project: ${a.name}`, lines: a.description ? [a.description.slice(0, 200)] : [] }),
  } satisfies ToolDef<any>,

  'tasks.comment': {
    description: 'Add a comment (progress note) to a task.',
    schema: z.object({ taskId: z.string().uuid(), body: z.string().trim().min(1).max(4000) }),
    async execute(q, ctx, a) {
      const t = await q.one(`select id, title from tasks where id=$1 and deleted_at is null`, [a.taskId]);
      if (!t) return fail('Task not found');
      const r = await q.one(`insert into task_comments (org_id, task_id, body, author_kind, author_id) values ($1,$2,$3,$4,$5) returning id`, [ctx.orgId, t.id, a.body, ctx.actor.kind, ctx.actor.id]);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'task.commented', targetRef: `task:${t.id}`, detail: { comment: r.id } });
      return { ok: true, summary: `Commented on “${t.title}”`, refs: [{ type: 'task', id: t.id, title: t.title }] };
    },
    preview: (a) => ({ title: 'Comment on task', lines: [a.body.slice(0, 300)] }),
  } satisfies ToolDef<any>,

  'business.snapshot': {
    description: 'A quick business snapshot: tasks (open, overdue, due this week), contacts by stage, leads in the last 7 and 30 days, pending approvals and automation runs that need attention.',
    schema: z.object({}),
    async execute(q) {
      const [tasks, stages, leads, pending] = await Promise.all([
        q.one(`select count(*) filter (where status <> 'done') as open, count(*) filter (where status <> 'done' and due_at < now()) as overdue,
                      count(*) filter (where status <> 'done' and due_at >= now() and due_at < now() + interval '7 days') as due_this_week,
                      count(*) filter (where status = 'done' and completed_at > now() - interval '7 days') as done_last_7d
                 from tasks where deleted_at is null`),
        q.many(`select coalesce(nullif(stage, ''), 'none') as stage, count(*) as n from contacts where deleted_at is null group by 1 order by 2 desc limit 12`),
        q.one(`select count(*) filter (where received_at > now() - interval '7 days') as last_7d, count(*) filter (where received_at > now() - interval '30 days') as last_30d,
                      count(*) filter (where received_at > now() - interval '7 days' and urgency in ('high','urgent')) as urgent_7d
                 from lead_inbox where is_lead`),
        q.one(`select (select count(*) from approval_requests where status='pending' and expires_at > now()) as approvals,
                      (select count(*) from workflow_runs where status in ('needs_attention','waiting_approval')) as runs_need_you`),
      ]);
      const n = (x: unknown) => Number(x ?? 0);
      const data = {
        tasks: { open: n(tasks?.open), overdue: n(tasks?.overdue), dueThisWeek: n(tasks?.due_this_week), doneLast7Days: n(tasks?.done_last_7d) },
        contactsByStage: Object.fromEntries(stages.map((s: any) => [s.stage, n(s.n)])),
        leads: { last7Days: n(leads?.last_7d), last30Days: n(leads?.last_30d), urgentLast7Days: n(leads?.urgent_7d) },
        waitingForYou: { approvals: n(pending?.approvals), automationRuns: n(pending?.runs_need_you) },
      };
      return { ok: true, summary: `${data.tasks.open} open tasks (${data.tasks.overdue} overdue), ${data.leads.last7Days} leads this week, ${data.waitingForYou.approvals} approvals waiting`, refs: [], data };
    },
    preview: () => ({ title: 'Business snapshot', lines: [] }),
  } satisfies ToolDef<any>,

  'sheets.read': {
    description: 'Read rows from a Google Sheet that Qline created (give its link or id). Returns the first tab, up to 200 rows.',
    schema: z.object({ sheet: z.string().min(10).max(300).describe('Sheet URL or id'), limit: z.number().int().min(1).max(200).optional() }),
    async execute(q, _ctx, a) {
      const id = sheetId(a.sheet);
      if (!id) return fail('That is not a Google Sheets link or id.');
      const c = await conn(q, 'google', 'drive.file');
      if (typeof c === 'string') return fail(c);
      const r = await api(c.token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:Z${(a.limit ?? 100) + 1}`).catch((e: Error) => e);
      if (r instanceof Error) return fail(`Could not read the sheet. Qline can only open sheets it created. (${r.message.slice(0, 160)})`);
      const rows = ((r as any).values ?? []) as string[][];
      return { ok: true, summary: `${Math.max(0, rows.length - 1)} row${rows.length === 2 ? '' : 's'} plus header`, refs: [{ type: 'link', id: `https://docs.google.com/spreadsheets/d/${id}/edit`, title: 'Sheet' }], data: { header: rows[0] ?? [], rows: rows.slice(1) } };
    },
    preview: (a) => ({ title: 'Read sheet', lines: [a.sheet] }),
  } satisfies ToolDef<any>,

  'sheets.append': {
    description: 'Add rows to the end of a Google Sheet that Qline created (give its link or id). Never overwrites existing rows.',
    schema: z.object({ sheet: z.string().min(10).max(300), rows: z.array(z.array(z.string().max(2000)).min(1).max(30)).min(1).max(200) }),
    async execute(q, ctx, a) {
      const id = sheetId(a.sheet);
      if (!id) return fail('That is not a Google Sheets link or id.');
      const c = await conn(q, 'google', 'drive.file');
      if (typeof c === 'string') return fail(c);
      const r = await api(c.token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { body: { values: a.rows } }).catch((e: Error) => e);
      if (r instanceof Error) return fail(`Could not add rows. Qline can only edit sheets it created. (${r.message.slice(0, 160)})`);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'sheet.rows_appended', targetRef: `sheet:${id}`, detail: { rows: a.rows.length } });
      return { ok: true, summary: `Added ${a.rows.length} row${a.rows.length === 1 ? '' : 's'} to the sheet`, refs: [{ type: 'link', id: `https://docs.google.com/spreadsheets/d/${id}/edit`, title: 'Sheet' }] };
    },
    preview: (a) => ({ title: `Add ${a.rows.length} row${a.rows.length === 1 ? '' : 's'} to a sheet`, lines: a.rows.slice(0, 5).map((r: string[]) => r.join(' · ').slice(0, 200)) }),
  } satisfies ToolDef<any>,

  'slack.channels': {
    description: 'List the public channels in the connected Slack workspace, and which one Qline posts to by default.',
    schema: z.object({}),
    async execute(q) {
      const c = await conn(q, 'slack');
      if (typeof c === 'string') return fail(c);
      const list = await slackChannels(c.token);
      const def = c.conn.settings?.channel ?? null;
      return { ok: true, summary: `${list.length} channel${list.length === 1 ? '' : 's'}${def?.name ? `; default #${def.name}` : ''}`, refs: [], data: { defaultChannel: def, channels: list.slice(0, 100) } };
    },
    preview: () => ({ title: 'List Slack channels', lines: [] }),
  } satisfies ToolDef<any>,
};
