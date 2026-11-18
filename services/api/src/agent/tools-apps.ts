import { z } from 'zod';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { createContact, notify } from '../modules/work';
import { accessToken, api, hasScope } from '../integrations/oauth';
import { createCalendarEvent, formCreateCustom, formResponsesReadable, gmailMessage, gmailSearch, gmailSend, outlookSearch, outlookSend, sheetCreateCustom, slackChannels, slackPost, upcomingEvents } from '../integrations/services';
import { slackName } from './tools-more';
import type { ToolDef } from './tools';

/**
 * v1.3 agent tools that reach connected apps (Gmail / Outlook, Calendar, Forms, Sheets, Slack)
 * and the rest of Qline (leads, approvals, automations, notifications).
 * Every tool uses the organization's own connection and only the scopes that were granted.
 */

type Conn = { conn: any; token: string };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function connection(q: Q, providers: ('google' | 'microsoft' | 'slack')[], scope?: (p: string) => string): Promise<Conn | string> {
  const rows = await q.many(`select * from integration_connections where provider = any($1) and status='ok' order by provider`, [providers]);
  const conn = rows.find((c: any) => !scope || hasScope(c, scope(c.provider)));
  if (!conn) {
    const names = providers.map((p) => ({ google: 'Google', microsoft: 'Microsoft', slack: 'Slack' })[p]).join(' or ');
    return rows.length
      ? `${names} is connected but without the permission this needs. Reconnect it in Settings → Integrations and allow the requested access.`
      : `${names} is not connected. Connect it in Settings → Integrations first.`;
  }
  try {
    return { conn, token: await accessToken(q, conn) };
  } catch (e) {
    return (e as Error).message;
  }
}

export const fail = (summary: string) => ({ ok: false, summary, refs: [] });
const mailScope = (p: string) => (p === 'google' ? 'gmail.readonly' : 'Mail.Read');

const question = z.object({
  title: z.string().trim().min(1).max(300),
  type: z.enum(['short', 'paragraph', 'multiple_choice', 'checkboxes', 'dropdown', 'date', 'scale']).default('short'),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(30).optional().describe('Choices for multiple_choice, checkboxes or dropdown'),
});

type Qn = z.infer<typeof question>;

export const appTools = {
  'gmail.search': {
    description:
      'Search the connected mailbox (Gmail, or Outlook if that is what is connected). Use Gmail search syntax, e.g. "from:dana newer_than:7d", "is:unread", "invoice". Returns sender, subject, date and a short snippet.',
    schema: z.object({ query: z.string().max(300).default('in:inbox newer_than:3d'), limit: z.number().int().min(1).max(15).optional() }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['google', 'microsoft'], mailScope);
      if (typeof c === 'string') return fail(c);
      const rows = c.conn.provider === 'google' ? await gmailSearch(c.token, a.query, a.limit ?? 8) : await outlookSearch(c.token, a.query, a.limit ?? 8);
      return { ok: true, summary: `${rows.length} email${rows.length === 1 ? '' : 's'} found`, refs: [], data: rows };
    },
    preview: (a) => ({ title: 'Search email', lines: [a.query] }),
  } satisfies ToolDef<any>,

  'gmail.read': {
    description: 'Read one email in full (use an id from gmail.search).',
    schema: z.object({ id: z.string().min(1).max(200) }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['google', 'microsoft'], mailScope);
      if (typeof c === 'string') return fail(c);
      const m = c.conn.provider === 'google' ? await gmailMessage(c.token, a.id) : await api(c.token, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(a.id)}?$select=subject,from,receivedDateTime,body`, { headers: { Prefer: 'outlook.body-content-type="text"' } }).then((x: any) => ({ id: a.id, from: x.from?.emailAddress?.address, subject: x.subject, date: x.receivedDateTime, text: String(x.body?.content ?? '').slice(0, 4000) }));
      return { ok: true, summary: `Read “${String(m.subject ?? '').slice(0, 80)}”`, refs: [], data: m };
    },
    preview: (a) => ({ title: 'Read email', lines: [a.id] }),
  } satisfies ToolDef<any>,

  'email.send': {
    description: 'Send an email from the connected Gmail or Outlook account. Always needs the user\'s approval first.',
    schema: z.object({ to: z.string().trim().max(320), subject: z.string().trim().min(1).max(300), body: z.string().min(1).max(20000) }),
    async execute(q, ctx, a) {
      if (!EMAIL.test(a.to)) return fail(`Not a valid email address: "${a.to}"`);
      const c = await connection(q, ['google', 'microsoft'], (p) => (p === 'google' ? 'gmail.send' : 'Mail.Send'));
      if (typeof c === 'string') return fail(c);
      if (c.conn.provider === 'google') await gmailSend(c.token, a.to, a.subject, a.body);
      else await outlookSend(c.token, a.to, a.subject, a.body);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'email.sent', targetRef: `email:${a.to}`, detail: { subject: a.subject, via: c.conn.provider } });
      return { ok: true, summary: `Sent “${a.subject}” to ${a.to}`, refs: [] };
    },
    preview: (a) => ({ title: `Send email to ${a.to}`, lines: [`Subject: ${a.subject}`, a.body.slice(0, 400)] }),
  } satisfies ToolDef<any>,

  'calendar.list': {
    description: 'List upcoming events on the connected Google or Outlook calendar.',
    schema: z.object({ days: z.number().int().min(1).max(30).default(7) }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['google', 'microsoft'], (p) => (p === 'google' ? 'calendar.events' : 'Calendars.ReadWrite'));
      if (typeof c === 'string') return fail(c);
      const ev = await upcomingEvents(c.conn.provider, c.token, a.days);
      return { ok: true, summary: `${ev.length} event${ev.length === 1 ? '' : 's'} in the next ${a.days} days`, refs: [], data: ev };
    },
    preview: (a) => ({ title: 'Check calendar', lines: [`Next ${a.days} days`] }),
  } satisfies ToolDef<any>,

  'calendar.create': {
    description: 'Add an event to the user\'s own calendar (no guests are invited). Give the start as ISO 8601 with a timezone offset.',
    schema: z.object({ title: z.string().trim().min(1).max(200), start: z.string().datetime({ offset: true }), minutes: z.number().int().min(5).max(720).default(30), description: z.string().max(4000).optional() }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google', 'microsoft'], (p) => (p === 'google' ? 'calendar.events' : 'Calendars.ReadWrite'));
      if (typeof c === 'string') return fail(c);
      const ev = await createCalendarEvent(c.conn.provider, c.token, { title: a.title, start: new Date(a.start), minutes: a.minutes, description: a.description });
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'calendar.event.created', targetRef: `event:${ev.id}`, detail: { title: a.title } });
      return { ok: true, summary: `Added “${a.title}” to your calendar`, refs: [{ type: 'link', id: ev.url, title: a.title }], data: { url: ev.url } };
    },
    preview: (a) => ({ title: `Calendar: ${a.title}`, lines: [`${a.start} · ${a.minutes} min`] }),
  } satisfies ToolDef<any>,

  'forms.create': {
    description:
      'Create a Google Form with your own questions, publish it, and return its public link (to share) and edit link. Use this whenever the user asks for a form, survey, sign-up sheet, booking or feedback form. Always give the user the responderUrl.',
    schema: z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(), questions: z.array(question).min(1).max(40) }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google'], () => 'drive.file');
      if (typeof c === 'string') return fail(c);
      const f = await formCreateCustom(c.token, a.title, a.description ?? '', a.questions);
      const doc = await q.one(
        `insert into documents (org_id, workspace_id, kind, title, body, folder, source_kind, source_ref, created_by) values ($1,$2,'note',$3,$4,'Forms','agent_inferred',$5,$5) returning id`,
        [ctx.orgId, ctx.workspaceId, `Form: ${a.title}`, `Share: ${f.responderUri}\nEdit: ${f.editUrl}\nForm ID: ${f.id}\n\nQuestions:\n${a.questions.map((x: Qn, i: number) => `${i + 1}. ${x.title} (${x.type})`).join('\n')}`, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'form.created', targetRef: `form:${f.id}`, detail: { title: a.title, questions: a.questions.length } });
      return {
        ok: true,
        summary: `Created form “${a.title}” (${a.questions.length} questions)`,
        refs: [{ type: 'link', id: f.responderUri, title: `${a.title} (share link)` }, { type: 'document', id: doc.id, title: `Form: ${a.title}` }],
        data: { formId: f.id, responderUrl: f.responderUri, editUrl: f.editUrl },
      };
    },
    preview: (a) => ({ title: `Create form: ${a.title}`, lines: a.questions.slice(0, 6).map((x: Qn) => `• ${x.title}`) }),
  } satisfies ToolDef<any>,

  'forms.responses': {
    description: 'Read the answers submitted to a Google Form Qline created (give the formId).',
    schema: z.object({ formId: z.string().min(5).max(200), limit: z.number().int().min(1).max(50).optional() }),
    async execute(q, _ctx, a) {
      const c = await connection(q, ['google'], () => 'drive.file');
      if (typeof c === 'string') return fail(c);
      const rows = await formResponsesReadable(c.token, a.formId, a.limit ?? 20);
      return { ok: true, summary: `${rows.length} response${rows.length === 1 ? '' : 's'}`, refs: [], data: rows };
    },
    preview: (a) => ({ title: 'Read form responses', lines: [a.formId] }),
  } satisfies ToolDef<any>,

  'sheets.create': {
    description: 'Create a Google Sheet with column headers and optional rows, and return its link.',
    schema: z.object({ title: z.string().trim().min(1).max(200), headers: z.array(z.string().max(100)).min(1).max(30), rows: z.array(z.array(z.string().max(2000)).max(30)).max(500).optional() }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['google'], () => 'drive.file');
      if (typeof c === 'string') return fail(c);
      const s = await sheetCreateCustom(c.token, a.title, a.headers, a.rows ?? []);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'sheet.created', targetRef: `sheet:${s.id}`, detail: { title: a.title } });
      return { ok: true, summary: `Created sheet “${a.title}”`, refs: [{ type: 'link', id: s.url, title: a.title }], data: { url: s.url } };
    },
    preview: (a) => ({ title: `Create sheet: ${a.title}`, lines: [a.headers.join(' · ')] }),
  } satisfies ToolDef<any>,

  'slack.post': {
    description: 'Post a message to Slack: the channel picked in Integrations, or another public channel by name (see slack.channels). Needs approval.',
    schema: z.object({ text: z.string().trim().min(1).max(4000), channel: z.string().trim().max(80).optional().describe('Public channel name, e.g. sales. Omit for the default channel.') }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['slack']);
      if (typeof c === 'string') return fail(c);
      let ch: { id: string; name?: string } | undefined = c.conn.settings?.channel;
      if (a.channel) {
        const want = slackName(a.channel);
        ch = (await slackChannels(c.token)).find((x: { id: string; name: string }) => x.name === want || x.id === a.channel);
        if (!ch) return fail(`No public Slack channel named #${want}.`);
      }
      if (!ch?.id) return fail('Pick a Slack channel in Settings → Integrations → Slack first, or name a channel.');
      await slackPost(c.token, ch.id, a.text);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'slack.posted', targetRef: `slack:${ch.id}` });
      return { ok: true, summary: `Posted to #${ch.name ?? 'channel'}`, refs: [] };
    },
    preview: (a) => ({ title: a.channel ? `Post to Slack #${slackName(a.channel)}` : 'Post to Slack', lines: [a.text.slice(0, 400)] }),
  } satisfies ToolDef<any>,

  'leads.list': {
    description: 'List recent leads Qline found in email, forms and sheets, newest first.',
    schema: z.object({ urgentOnly: z.boolean().optional(), days: z.number().int().min(1).max(90).default(14), limit: z.number().int().min(1).max(30).optional() }),
    async execute(q, _ctx, a) {
      const rows = await q.many(
        `select id, source, from_name, from_email, subject, summary, urgency, score, received_at, contact_id from lead_inbox
         where is_lead and received_at > now() - make_interval(days => $1) and (not $2 or urgency in ('high','urgent')) order by received_at desc limit $3`,
        [a.days, a.urgentOnly ?? false, a.limit ?? 10],
      );
      return { ok: true, summary: `${rows.length} lead${rows.length === 1 ? '' : 's'}`, refs: rows.filter((r: any) => r.contact_id).map((r: any) => ({ type: 'contact', id: r.contact_id, title: r.from_name ?? r.from_email })), data: rows };
    },
    preview: () => ({ title: 'List leads', lines: [] }),
  } satisfies ToolDef<any>,

  'approvals.list': {
    description: 'List actions that are waiting for the user\'s approval.',
    schema: z.object({}),
    async execute(q) {
      const rows = await q.many(`select id, action, risk, preview->>'title' as title, created_at, expires_at from approval_requests where status='pending' and expires_at > now() order by created_at desc limit 20`);
      return { ok: true, summary: `${rows.length} waiting for approval`, refs: rows.map((r: any) => ({ type: 'approval', id: r.id, title: r.title })), data: rows };
    },
    preview: () => ({ title: 'List approvals', lines: [] }),
  } satisfies ToolDef<any>,

  'workflows.list': {
    description: 'List the organization\'s automations (workflows) and whether they are on.',
    schema: z.object({}),
    async execute(q) {
      const rows = await q.many(`select id, name, description, status, published_version from workflows order by updated_at desc limit 30`);
      return { ok: true, summary: `${rows.length} automation${rows.length === 1 ? '' : 's'}`, refs: rows.map((r: any) => ({ type: 'workflow', id: r.id, title: r.name })), data: rows };
    },
    preview: () => ({ title: 'List automations', lines: [] }),
  } satisfies ToolDef<any>,

  'workflows.run': {
    description: 'Run one of the organization\'s published automations now. Needs approval.',
    schema: z.object({ workflowId: z.string().uuid() }),
    async execute(q, ctx, a) {
      const wf = await q.one(`select id, name, published_version from workflows where id=$1`, [a.workflowId]);
      if (!wf) return fail('Automation not found');
      if (!wf.published_version) return fail(`“${wf.name}” is not published yet`);
      const { startWorkflowRun } = await import('../modules/workflows');
      const run = await startWorkflowRun({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId }, wf.id, { kind: 'manual', data: {} });
      return { ok: true, summary: `Ran “${wf.name}”${run?.status ? ` (${run.status})` : ''}`, refs: [{ type: 'workflow', id: wf.id, title: wf.name }] };
    },
    preview: (a) => ({ title: 'Run automation', lines: [a.workflowId] }),
  } satisfies ToolDef<any>,

  'notify.me': {
    description: 'Send the user a notification on their phone (and in Qline). Use when they ask to be reminded or alerted, or when you find something important.',
    schema: z.object({ title: z.string().trim().min(1).max(140), body: z.string().max(1000).optional() }),
    async execute(q, ctx, a) {
      await notify(q, ctx.orgId, ctx.userId, { category: 'assistant', title: a.title, body: a.body });
      return { ok: true, summary: 'Notification sent', refs: [] };
    },
    preview: (a) => ({ title: `Notify: ${a.title}`, lines: a.body ? [a.body] : [] }),
  } satisfies ToolDef<any>,

  'contacts.create': {
    description: 'Add a contact (person) to the CRM.',
    schema: z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().max(320).optional(), phone: z.string().max(60).optional(), title: z.string().max(200).optional(), stage: z.string().max(60).optional(), notes: z.string().max(4000).optional() }),
    async execute(q, ctx, a) {
      if (a.email && !EMAIL.test(a.email)) return fail(`Not a valid email address: "${a.email}"`);
      const row = await createContact(q, ctx, ctx.actor, a as any, { kind: 'agent_inferred', ref: `${ctx.actor.kind}:${ctx.actor.id}` });
      return { ok: true, summary: `Added contact ${row.name}`, refs: [{ type: 'contact', id: row.id, title: row.name }] };
    },
    preview: (a) => ({ title: `Add contact: ${a.name}`, lines: [a.email, a.phone, a.stage].filter(Boolean) as string[] }),
  } satisfies ToolDef<any>,
};
