import { complete } from '@qline/ai';
import { resolveModel } from '../agent/models';
import { audit } from '../core/audit';
import type { Q } from '../core/db';
import { accessToken, hasScope } from './oauth';
import { createCalendarEvent, gmailSend, outlookSend, slackPost } from './services';

/** Executes the v1.2 automation step types inside a workflow run. */
export async function runAutomationStep(
  q: Q,
  ctx: { orgId: string; workspaceId: string; ownerId: string; runId: string },
  s: any,
): Promise<{ ok: boolean; summary: string; skipped?: boolean; text?: string }> {
  if (s.type === 'ai') {
    const m = await resolveModel(q, ctx.orgId);
    if (!m.ok) return { ok: false, summary: m.message };
    try {
      const r = await complete(m.provider, {
        model: m.model,
        maxTokens: 900,
        messages: [
          { role: 'system', content: 'You are an automation step inside a small-business workflow. Reply with only the requested text, no preamble, no markdown headings. Never invent facts that are not in the input.' },
          { role: 'user', content: s.prompt },
        ],
      });
      const text = r.text.trim();
      return { ok: true, summary: `AI wrote ${text.split(/\s+/).length} words`, text };
    } catch (e) {
      return { ok: false, summary: `AI step failed: ${(e as Error).message.slice(0, 200)}` };
    }
  }

  if (s.type === 'slack') {
    const conn = await q.one(`select * from integration_connections where provider='slack' and status='ok'`);
    const ch = conn?.settings?.channel?.id;
    if (!conn || !ch) return { ok: true, skipped: true, summary: 'Skipped: Slack is not connected or no channel is picked' };
    try {
      await slackPost(await accessToken(q, conn), ch, s.text);
      return { ok: true, summary: `Posted to #${conn.settings.channel.name ?? 'channel'}` };
    } catch (e) {
      return { ok: false, summary: `Slack: ${(e as Error).message.slice(0, 200)}` };
    }
  }

  if (s.type === 'email') {
    const to = String(s.to).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, summary: `Not a valid email address: "${to}"` };
    const conns = await q.many(`select * from integration_connections where provider in ('google','microsoft') and status='ok'`);
    const conn = conns.find((c: any) => hasScope(c, c.provider === 'google' ? 'gmail.send' : 'Mail.Send'));
    if (!conn) return { ok: false, summary: 'No email account that can send is connected (connect Gmail or Outlook).' };
    try {
      const token = await accessToken(q, conn);
      if (conn.provider === 'google') await gmailSend(token, to, s.subject, s.body);
      else await outlookSend(token, to, s.subject, s.body);
      await audit(q, { orgId: ctx.orgId, actorKind: 'workflow', actorId: ctx.runId, action: 'email.sent', targetRef: `email:${to}`, detail: { subject: s.subject, via: conn.provider } });
      return { ok: true, summary: `Sent "${s.subject}" to ${to} from ${conn.account_email ?? conn.provider}` };
    } catch (e) {
      return { ok: false, summary: `Sending failed: ${(e as Error).message.slice(0, 200)}` };
    }
  }

  if (s.type === 'calendar') {
    const conns = await q.many(`select * from integration_connections where provider in ('google','microsoft') and status='ok'`);
    const conn = conns.find((c: any) => hasScope(c, c.provider === 'google' ? 'calendar.events' : 'Calendars.ReadWrite'));
    if (!conn) return { ok: true, skipped: true, summary: 'Skipped: no calendar is connected' };
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + s.inDays);
    start.setUTCHours(s.hourUtc, 0, 0, 0);
    if (start.getTime() < Date.now()) start.setUTCDate(start.getUTCDate() + 1);
    try {
      const ev = await createCalendarEvent(conn.provider, await accessToken(q, conn), { title: s.title, start, minutes: s.minutes, description: 'Created by a Qline workflow' });
      return { ok: true, summary: `Added "${s.title}" to the calendar (${start.toISOString().slice(0, 16).replace('T', ' ')} UTC)${ev.url ? '' : ''}` };
    } catch (e) {
      return { ok: false, summary: `Calendar: ${(e as Error).message.slice(0, 200)}` };
    }
  }
  return { ok: false, summary: `Unknown step ${s.type}` };
}

/** Plain-text business snapshot for scheduled workflows ({{trigger.leads_text}} etc.). */
export async function buildDigest(q: Q) {
  const leads = await q.many(
    `select name, urgency, coalesce(lead_summary,'') as s from contacts where deleted_at is null and stage='lead' and created_at > now() - interval '24 hours' order by created_at desc limit 15`,
  );
  const overdue = await q.many(`select title, due_at from tasks where deleted_at is null and status <> 'done' and due_at < now() order by due_at limit 15`);
  const today = await q.many(
    `select title from tasks where deleted_at is null and status <> 'done' and due_at >= now() and due_at < now() + interval '24 hours' order by due_at limit 15`,
  );
  const fmt = (rows: any[], f: (r: any) => string) => (rows.length ? rows.map((r) => `- ${f(r)}`).join('\n') : '(none)');
  return {
    leads_count: leads.length,
    urgent_count: leads.filter((l: any) => l.urgency === 'urgent' || l.urgency === 'high').length,
    leads_text: fmt(leads, (l) => `${l.name}${l.urgency ? ` [${l.urgency}]` : ''}${l.s ? `: ${l.s}` : ''}`),
    overdue_count: overdue.length,
    overdue_text: fmt(overdue, (t) => `${t.title} (due ${new Date(t.due_at).toISOString().slice(0, 10)})`),
    due_today_text: fmt(today, (t) => t.title),
  };
}

// ---- Ready-made automations ----------------------------------------------------------------------
export const RECIPES = [
  {
    id: 'urgent_lead_alert',
    name: 'Urgent lead alert',
    description: 'When a hot or urgent lead arrives, notify the team and Slack, then offer to create a reply task.',
    needs: ['Lead inbox (Gmail, Outlook or Forms)', 'Slack (optional)'],
    definition: {
      trigger: { type: 'event', event: 'lead.urgent' },
      steps: [
        { type: 'notify', title: 'Hot lead: {{trigger.name}}', body: '{{trigger.summary}}' },
        { type: 'slack', text: ':rotating_light: Hot lead — *{{trigger.name}}* ({{trigger.email}})\n{{trigger.summary}}' },
        { type: 'approval', title: 'Create a reply task for {{trigger.name}}?' },
        { type: 'action', tool: 'tasks.create', args: { title: 'Reply to {{trigger.name}}: {{trigger.subject}}', priority: 'urgent', dueInDays: 0 } },
      ],
    },
  },
  {
    id: 'lead_auto_reply',
    name: 'AI reply to new leads',
    description: 'AI drafts a friendly first reply to every new lead. You review it, and it is sent from your Gmail/Outlook only after you approve.',
    needs: ['AI provider', 'Gmail or Outlook'],
    definition: {
      trigger: { type: 'event', event: 'lead.created' },
      steps: [
        {
          type: 'ai',
          saveAs: 'reply',
          prompt:
            'Write a short, warm first reply email body (under 120 words) to a new lead named {{trigger.name}}. What they asked: {{trigger.summary}} (subject: {{trigger.subject}}). Thank them, answer at a high level, and propose a quick call. Sign off as the team. Plain text only.',
        },
        { type: 'approval', title: 'Send this reply to {{trigger.name}}?' },
        { type: 'email', to: '{{trigger.email}}', subject: 'Re: {{trigger.subject}}', body: '{{reply}}' },
      ],
    },
  },
  {
    id: 'lead_follow_up',
    name: 'Follow-up reminder',
    description: 'For every new lead, book a 30-minute follow-up slot on your calendar in 2 days.',
    needs: ['Google or Outlook Calendar'],
    definition: {
      trigger: { type: 'event', event: 'lead.created' },
      steps: [{ type: 'calendar', title: 'Follow up: {{trigger.name}}', inDays: 2, hourUtc: 1, minutes: 30 }],
    },
  },
  {
    id: 'daily_briefing',
    name: 'Morning briefing',
    description: 'Every morning (8:00 Manila time), AI summarises new leads, overdue and due-today tasks into a short briefing in the app and Slack.',
    needs: ['AI provider', 'Slack (optional)'],
    definition: {
      trigger: { type: 'schedule', every: 'day', hourUtc: 0 },
      steps: [
        {
          type: 'ai',
          saveAs: 'brief',
          prompt:
            'Write a morning briefing for a business owner in at most 6 short lines: the most important thing first, then leads, then tasks. Use only this data.\nNew leads (24h, {{trigger.leads_count}}, {{trigger.urgent_count}} hot):\n{{trigger.leads_text}}\nOverdue tasks ({{trigger.overdue_count}}):\n{{trigger.overdue_text}}\nDue in the next 24h:\n{{trigger.due_today_text}}',
        },
        { type: 'notify', title: 'Morning briefing', body: '{{brief}}' },
        { type: 'slack', text: ':sunrise: *Morning briefing*\n{{brief}}' },
      ],
    },
  },
] as const;
