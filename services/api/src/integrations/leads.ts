import { z } from 'zod';
import { complete } from '@qline/ai';
import { resolveModel } from '../agent/models';
import { withTenant, type Q } from '../core/db';
import { dispatch, type DomainEvent } from '../core/events';
import { createContact, notify } from '../modules/work';
import { enqueue, registerJob } from '../runtime/jobs';
import { accessToken, ConnectionExpired, hasScope } from './oauth';
import {
  formResponses,
  gmailNewMessages,
  outlookNewMessages,
  sheetAppend,
  sheetRows,
  sheetSetCell,
  slackPost,
  type InboundMail,
} from './services';

// ---- Lead rules (organizations.settings.leads) ------------------------------------------------
export const URGENCY = ['low', 'normal', 'high', 'urgent'] as const;
export type Urgency = (typeof URGENCY)[number];

const list = z.array(z.string().trim().min(1).max(80)).max(100);
export const rulesSchema = z.object({
  enabled: z.boolean().default(true),
  useAi: z.boolean().default(true),
  instructions: z.string().max(2000).default(''),
  leadKeywords: list.default(['quote', 'pricing', 'price', 'interested', 'inquiry', 'enquiry', 'proposal', 'hire', 'services', 'demo', 'appointment', 'book', 'estimate', 'partnership', 'availability']),
  urgentKeywords: list.default(['urgent', 'asap', 'today', 'emergency', 'immediately', 'right away', 'deadline']),
  vipDomains: list.default([]),
  ignoreDomains: list.default([]),
  notifyOn: z.enum(['all', 'urgent', 'none']).default('all'),
  slackOn: z.enum(['all', 'urgent', 'none']).default('urgent'),
  /** Notify about emails that are not leads but need attention (bills, client issues, deadlines). */
  notifyImportant: z.boolean().default(true),
});
export type LeadRules = z.infer<typeof rulesSchema>;

export async function loadRules(q: Q, orgId: string): Promise<LeadRules> {
  const r = await q.one(`select settings->'leads' as leads from organizations where id=$1`, [orgId]);
  return rulesSchema.parse(r?.leads ?? {});
}

export async function saveRules(q: Q, orgId: string, rules: LeadRules) {
  await q.exec(`update organizations set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('leads', $2::jsonb) where id=$1`, [orgId, JSON.stringify(rules)]);
}

// ---- Classification ------------------------------------------------------------------------------
export interface Classified {
  isLead: boolean;
  urgency: Urgency;
  score: number;
  summary: string;
  reason: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  by: 'rules' | 'ai';
  /** Needs the owner's attention even if it is not a lead. */
  important?: boolean;
}

interface Item {
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  text: string;
  bulk?: boolean;
}

const rank = (u: Urgency) => URGENCY.indexOf(u);
const maxU = (a: Urgency, b: Urgency) => (rank(a) >= rank(b) ? a : b);
const domainOf = (e: string | null) => (e?.split('@')[1] ?? '').toLowerCase();
const hit = (hay: string, words: string[]) => words.find((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(hay));

export function classifyByRules(it: Item, r: LeadRules): Classified {
  const hay = `${it.subject}\n${it.text}`;
  const dom = domainOf(it.fromEmail);
  const base = { name: it.fromName, company: null, phone: (hay.match(/(\+?\d[\d\s().-]{7,}\d)/)?.[1] ?? null), by: 'rules' as const };
  if (r.ignoreDomains.some((d) => dom === d.toLowerCase() || dom.endsWith('.' + d.toLowerCase())))
    return { ...base, isLead: false, urgency: 'low', score: 0, summary: it.subject, reason: `Sender domain ${dom} is on the ignore list` };
  if (it.bulk) return { ...base, isLead: false, urgency: 'low', score: 5, summary: it.subject, reason: 'Automated or newsletter email' };
  const vip = r.vipDomains.some((d) => dom === d.toLowerCase() || dom.endsWith('.' + d.toLowerCase()));
  const lk = hit(hay, r.leadKeywords);
  const uk = hit(hay, r.urgentKeywords);
  const isLead = vip || !!lk;
  const important = !!uk || vip;
  let urgency: Urgency = isLead ? 'normal' : 'low';
  if (vip) urgency = 'high';
  if (uk && isLead) urgency = 'urgent';
  const reason = [vip ? `VIP domain ${dom}` : null, lk ? `mentions “${lk}”` : null, uk ? `urgent word “${uk}”` : null].filter(Boolean).join(', ') || 'No lead signals';
  return { ...base, isLead, important, urgency, score: isLead ? (urgency === 'urgent' ? 85 : vip ? 75 : 60) : 10, summary: it.subject, reason };
}

const aiOut = z.object({
  is_lead: z.boolean(),
  urgency: z.enum(URGENCY),
  score: z.number().min(0).max(100),
  summary: z.string().max(400),
  reason: z.string().max(300),
  name: z.string().max(200).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  important: z.boolean().optional(),
});

export async function classify(q: Q, orgId: string, it: Item, r: LeadRules, hint?: 'form'): Promise<Classified> {
  const rules = classifyByRules(it, r);
  if (hint === 'form') Object.assign(rules, { isLead: true, urgency: maxU(rules.urgency, 'normal'), score: Math.max(rules.score, 60), reason: 'Submitted the lead form' });
  if (!r.useAi) return rules;
  // Hard rules always win over the model.
  if (!rules.isLead && /ignore list/.test(rules.reason)) return rules;
  const m = await resolveModel(q, orgId);
  if (!m.ok) return rules;
  const system =
    'You triage inbound business messages for a small business. Decide if the message is a sales lead (a person or company that may buy, hire, book or partner). ' +
    'Rate urgency: urgent (needs a reply within hours, or explicit deadline/emergency), high (strong buying intent or important sender), normal, low. ' +
    'Also decide "important": true when the owner should see it soon even if it is not a lead (a bill or payment due, a client complaint or problem, a deadline, a security or account alert from a real service, a personal request from a known contact). Newsletters, promotions and routine notifications are not important. ' +
    'Reply with ONLY a JSON object: {"is_lead":bool,"important":bool,"urgency":"low|normal|high|urgent","score":0-100,"summary":"one sentence of what they want","reason":"short why","name":string|null,"company":string|null,"phone":string|null}.' +
    (r.instructions ? `\nBusiness rules from the owner (follow them):\n${r.instructions}` : '') +
    (r.urgentKeywords.length ? `\nTreat these words as urgent signals: ${r.urgentKeywords.join(', ')}.` : '') +
    (r.vipDomains.length ? `\nVIP sender domains (at least high): ${r.vipDomains.join(', ')}.` : '');
  const user = `From: ${it.fromName ?? ''} <${it.fromEmail ?? 'unknown'}>\nSubject: ${it.subject}\nAutomated/newsletter: ${it.bulk ? 'yes' : 'no'}\n\n${it.text.slice(0, 3000)}`;
  try {
    const res = await complete(m.provider, { model: m.model, maxTokens: 400, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    const json = res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1);
    const o = aiOut.parse(JSON.parse(json));
    let urgency = o.urgency;
    if (rules.urgency === 'urgent' && o.is_lead) urgency = 'urgent'; // explicit urgent keyword
    if (/VIP/.test(rules.reason)) urgency = maxU(urgency, 'high');
    return {
      isLead: o.is_lead || hint === 'form',
      urgency,
      score: Math.round(o.score),
      summary: o.summary,
      reason: o.reason,
      name: o.name ?? it.fromName,
      company: o.company ?? null,
      phone: o.phone ?? rules.phone,
      important: !!o.important || o.is_lead || (rules.important && !it.bulk),
      by: 'ai',
    };
  } catch (e) {
    return { ...rules, reason: `${rules.reason} (AI unavailable: ${(e as Error).message.slice(0, 80)})` };
  }
}

// ---- Turning items into leads --------------------------------------------------------------------
type Source = 'gmail' | 'outlook' | 'form' | 'sheet';
export interface SyncCtx {
  orgId: string;
  workspaceId: string;
  userId: string; // who connected (acts for)
}

async function recipients(q: Q, orgId: string, connectedBy: string) {
  const rows = await q.many(`select user_id from organization_members where org_id=$1 and status='active' and role in ('owner','admin')`, [orgId]);
  return [...new Set([connectedBy, ...rows.map((r: any) => r.user_id as string)])];
}

export interface Processed {
  inboxId: string;
  isLead: boolean;
  urgency: Urgency;
  contactId: string | null;
  name: string;
  email: string | null;
  summary: string;
  subject: string;
  source: Source;
  isNew: boolean;
  important?: boolean;
}

export async function processInbound(
  c: SyncCtx,
  source: Source,
  externalId: string,
  it: Item & { receivedAt?: Date },
  opts: { hint?: 'form'; preset?: Partial<Classified> } = {},
): Promise<Processed | null> {
  return withTenant({ orgId: c.orgId, userId: c.userId }, async (q) => {
    const ins = await q.one(
      `insert into lead_inbox (org_id, workspace_id, source, external_id, from_email, from_name, subject, snippet, received_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (org_id, source, external_id) do nothing returning id`,
      [c.orgId, c.workspaceId, source, externalId, it.fromEmail, it.fromName, it.subject.slice(0, 300), it.text.slice(0, 500), it.receivedAt ?? new Date()],
    );
    if (!ins) return null;
    const rules = await loadRules(q, c.orgId);
    if (!rules.enabled && source !== 'sheet') {
      await q.exec(`update lead_inbox set status='ignored', reason='Lead capture is turned off' where id=$1`, [ins.id]);
      return null;
    }
    const cl: Classified = opts.preset ? { ...classifyByRules(it, rules), isLead: true, by: 'rules', ...opts.preset } : await classify(q, c.orgId, it, rules, opts.hint);
    let contactId: string | null = null;
    let isNew = false;
    const name = (cl.name || it.fromName || it.fromEmail?.split('@')[0] || 'Unknown').slice(0, 200);
    if (cl.isLead) {
      const existing = it.fromEmail ? await q.one(`select id, urgency from contacts where lower(email)=lower($1) and deleted_at is null limit 1`, [it.fromEmail]) : null;
      if (existing) {
        contactId = existing.id;
      } else {
        const row = await createContact(q, c, { kind: 'workflow', id: `leads:${source}` }, {
          name,
          email: it.fromEmail ?? undefined,
          phone: cl.phone ?? undefined,
          title: cl.company ?? undefined,
          stage: 'lead',
          notes: `${cl.summary}\n\nFrom ${source}: ${it.subject}`.slice(0, 4000),
        } as any, { kind: source === 'sheet' ? 'import' : source, ref: externalId });
        contactId = row.id;
        isNew = true;
      }
      await q.exec(
        `update contacts set urgency = case when urgency is null or array_position(array['low','normal','high','urgent'], urgency) < array_position(array['low','normal','high','urgent'], $2) then $2 else urgency end,
           lead_score = greatest(coalesce(lead_score,0), $3), lead_summary=$4, last_inbound_at=now(), updated_at=now() where id=$1`,
        [contactId, cl.urgency, cl.score, cl.summary],
      );
    }
    await q.exec(
      `update lead_inbox set is_lead=$2, urgency=$3, score=$4, summary=$5, reason=$6, classified_by=$7, contact_id=$8, status=$9 where id=$1`,
      [ins.id, cl.isLead, cl.urgency, cl.score, cl.summary, cl.reason, cl.by, contactId, cl.isLead ? 'lead' : 'ignored'],
    );
    const importantMail = !cl.isLead && !!cl.important && !it.bulk && (source === 'gmail' || source === 'outlook');
    if (importantMail && rules.notifyImportant) {
      await notify(q, c.orgId, c.userId, {
        category: 'email_important',
        title: `Important email: ${it.subject.slice(0, 90)}`,
        body: `${it.fromName ?? it.fromEmail ?? 'Someone'}: ${cl.summary}`.slice(0, 500),
        ref: { type: 'lead_inbox', id: ins.id },
      });
    }
    if (cl.isLead) {
      const urgent = rank(cl.urgency) >= rank('high');
      if (rules.notifyOn === 'all' || (rules.notifyOn === 'urgent' && urgent)) {
        for (const u of await recipients(q, c.orgId, c.userId)) {
          await notify(q, c.orgId, u, {
            category: urgent ? 'lead_urgent' : 'lead',
            title: `${urgent ? (cl.urgency === 'urgent' ? 'Urgent lead' : 'Hot lead') : 'New lead'}: ${name}`,
            body: cl.summary,
            ref: { type: 'contact', id: contactId },
          });
        }
      }
    }
    return { inboxId: ins.id, isLead: cl.isLead, urgency: cl.urgency, contactId, name, email: it.fromEmail, summary: cl.summary, subject: it.subject, source, isNew, important: importantMail };
  });
}

/** After commit: workflow events + Slack alerts. */
export async function afterProcessed(c: SyncCtx, items: Processed[]) {
  const leads = items.filter((x) => x.isLead);
  const events: DomainEvent[] = [];
  for (const m of items.filter((x) => x.important)) {
    events.push({ type: 'email.important', id: `email-important:${m.inboxId}`, data: { subject: m.subject, from: m.email ?? m.name, summary: m.summary, source: m.source } });
  }
  if (!leads.length) {
    if (events.length) await dispatch({ orgId: c.orgId, workspaceId: c.workspaceId, userId: c.userId, email: '', name: '', sessionId: 'system', human: true, role: 'owner', correlationId: 'sync' } as any, events);
    return;
  }
  for (const l of leads) {
    const data = { id: l.contactId, name: l.name, email: l.email, urgency: l.urgency, summary: l.summary, subject: l.subject, source: l.source };
    if (l.isNew) events.push({ type: 'lead.created', id: `lead:${l.inboxId}`, data });
    if (rank(l.urgency) >= rank('high')) events.push({ type: 'lead.urgent', id: `lead-urgent:${l.inboxId}`, data });
  }
  const t: any = { orgId: c.orgId, workspaceId: c.workspaceId, userId: c.userId, email: '', name: '', sessionId: 'system', human: true, role: 'owner', correlationId: 'sync' };
  await dispatch(t, events);
  // Slack alerts
  const { slack, rules } = await withTenant({ orgId: c.orgId, userId: c.userId }, async (q) => ({
    slack: await q.one(`select * from integration_connections where provider='slack' and status='ok'`),
    rules: await loadRules(q, c.orgId),
  }));
  const channel = slack?.settings?.channel?.id;
  if (!slack || !channel || rules.slackOn === 'none') return;
  for (const l of leads) {
    if (rules.slackOn === 'urgent' && rank(l.urgency) < rank('high')) continue;
    try {
      const token = await withTenant({ orgId: c.orgId, userId: c.userId }, (q) => accessToken(q, slack));
      const tag = l.urgency === 'urgent' ? ':rotating_light: *Urgent lead*' : rank(l.urgency) >= 2 ? ':fire: *Hot lead*' : ':sparkles: *New lead*';
      await slackPost(token, channel, `${tag} — ${l.name}${l.email ? ` <mailto:${l.email}|${l.email}>` : ''}\n${l.summary}\n_via ${l.source} · Qline_`);
    } catch (e) {
      console.error('slack alert failed', (e as Error).message);
    }
  }
}

// ---- Per-connection sync -----------------------------------------------------------------------------
export interface SyncResult {
  checked: number;
  leads: number;
  exported: number;
  errors: string[];
}

async function loadConn(c: SyncCtx, id: string) {
  return withTenant({ orgId: c.orgId, userId: c.userId }, (q) => q.one('select * from integration_connections where id=$1', [id]));
}

async function saveCursor(c: SyncCtx, id: string, patch: Record<string, unknown>, settingsPatch?: Record<string, unknown>) {
  await withTenant({ orgId: c.orgId, userId: c.userId }, (q) =>
    q.exec(`update integration_connections set cursor = cursor || $2::jsonb, settings = settings || $3::jsonb, updated_at=now() where id=$1`, [id, JSON.stringify(patch), JSON.stringify(settingsPatch ?? {})]),
  );
}

async function mailSync(c: SyncCtx, conn: any, token: string, res: SyncResult) {
  const provider = conn.provider as 'google' | 'microsoft';
  const key = provider === 'google' ? 'gmail' : 'outlook';
  if (conn.settings?.[key]?.enabled === false) return;
  if (!hasScope(conn, provider === 'google' ? 'gmail.readonly' : 'Mail.Read')) return;
  const since = conn.cursor?.[`${key}After`] ? new Date(conn.cursor[`${key}After`]) : new Date(Date.now() - 2 * 86_400_000);
  const mails: InboundMail[] = provider === 'google' ? await gmailNewMessages(token, Math.floor(since.getTime() / 1000)) : await outlookNewMessages(token, since.toISOString());
  const done: Processed[] = [];
  let newest = since;
  for (const m of mails.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) {
    res.checked += 1;
    if (m.fromEmail && conn.account_email && m.fromEmail === conn.account_email.toLowerCase()) continue; // own mail
    const p = await processInbound(c, key, m.id, m);
    if (p) done.push(p);
    if (m.receivedAt > newest) newest = m.receivedAt;
  }
  res.leads += done.filter((d) => d.isLead).length;
  await saveCursor(c, conn.id, { [`${key}After`]: newest.toISOString() });
  await afterProcessed(c, done);
}

async function formSync(c: SyncCtx, conn: any, token: string, res: SyncResult) {
  const f = conn.settings?.form;
  if (!f?.id) return;
  const rs = await formResponses(token, f.id, conn.cursor?.formAfter ?? null);
  const done: Processed[] = [];
  let newest: string | null = conn.cursor?.formAfter ?? null;
  const get = (r: any, k: string) => (f.questions?.[k] ? r.answers?.[f.questions[k]]?.textAnswers?.answers?.[0]?.value : undefined) ?? '';
  for (const r of rs) {
    res.checked += 1;
    const email = String(get(r, 'email') || r.respondentEmail || '').trim().toLowerCase() || null;
    const name = String(get(r, 'name')).trim() || null;
    const message = String(get(r, 'message'));
    const phone = String(get(r, 'phone')).trim();
    const company = String(get(r, 'company')).trim();
    const p = await processInbound(
      c,
      'form',
      r.responseId,
      { fromEmail: email, fromName: name, subject: `Form: ${message.slice(0, 80) || 'new response'}`, text: `${message}\n${phone ? `Phone: ${phone}\n` : ''}${company ? `Company: ${company}` : ''}`, receivedAt: new Date(r.lastSubmittedTime ?? Date.now()) },
      { hint: 'form' },
    );
    if (p) done.push(p);
    if (!newest || r.lastSubmittedTime > newest) newest = r.lastSubmittedTime;
  }
  res.leads += done.filter((d) => d.isLead).length;
  if (newest) await saveCursor(c, conn.id, { formAfter: newest });
  await afterProcessed(c, done);
}

async function sheetSync(c: SyncCtx, conn: any, token: string, res: SyncResult) {
  const s = conn.settings?.sheet;
  if (!s?.id) return;
  const rows = await sheetRows(token, s.id);
  const ids = new Set<string>();
  const done: Processed[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const id = (r[0] ?? '').trim();
    if (id) {
      ids.add(id);
      continue;
    }
    const name = (r[1] ?? '').trim();
    const email = (r[2] ?? '').trim().toLowerCase() || null;
    if (!name && !email) continue;
    res.checked += 1;
    const urg = (URGENCY as readonly string[]).includes((r[6] ?? '').trim().toLowerCase()) ? ((r[6] ?? '').trim().toLowerCase() as Urgency) : 'normal';
    const p = await processInbound(
      c,
      'sheet',
      `${s.id}:${i + 2}:${email ?? name}`,
      { fromEmail: email, fromName: name || null, subject: `Sheet row ${i + 2}`, text: r[7] ?? '' },
      { preset: { name: name || null, phone: (r[3] ?? '').trim() || null, company: (r[4] ?? '').trim() || null, urgency: urg, summary: (r[7] ?? '').trim() || 'Added in Google Sheets', reason: 'Row added in the Qline Leads sheet', score: 50 } },
    );
    if (p?.contactId) {
      await sheetSetCell(token, s.id, `A${i + 2}`, p.contactId);
      ids.add(p.contactId);
      done.push(p);
    }
  }
  res.leads += done.length;
  // Export leads created in Qline (any source) that aren't in the sheet yet.
  const leads = await withTenant({ orgId: c.orgId, userId: c.userId }, (q) =>
    q.many(
      `select c.id, c.name, c.email, c.phone, c.title, c.stage, c.urgency, c.lead_summary, c.source_kind, c.created_at from contacts c
       where c.deleted_at is null and c.stage='lead' order by c.created_at limit 500`,
    ),
  );
  const add = leads
    .filter((l: any) => !ids.has(l.id))
    .map((l: any) => [l.id, l.name ?? '', l.email ?? '', l.phone ?? '', l.title ?? '', l.stage ?? '', l.urgency ?? '', l.lead_summary ?? '', l.source_kind ?? '', new Date(l.created_at).toISOString().slice(0, 16).replace('T', ' ')]);
  await sheetAppend(token, s.id, add);
  res.exported += add.length;
  await afterProcessed(c, done);
}

export async function syncConnection(c: SyncCtx, connectionId: string): Promise<SyncResult> {
  const res: SyncResult = { checked: 0, leads: 0, exported: 0, errors: [] };
  const conn = await loadConn(c, connectionId);
  if (!conn || conn.status !== 'ok') return res;
  let token: string;
  try {
    token = await withTenant({ orgId: c.orgId, userId: c.userId }, (q) => accessToken(q, conn));
  } catch (e) {
    if (e instanceof ConnectionExpired) {
      await withTenant({ orgId: c.orgId, userId: c.userId }, (q) => notify(q, c.orgId, conn.connected_by, { category: 'integration', title: 'Reconnect needed', body: e.message, ref: { type: 'integration', id: conn.provider } }));
    }
    res.errors.push((e as Error).message);
    return res;
  }
  const steps = conn.provider === 'google' ? [mailSync, formSync, sheetSync] : conn.provider === 'microsoft' ? [mailSync] : [];
  for (const s of steps) {
    try {
      await s(c, conn, token, res);
    } catch (e) {
      res.errors.push(`${s.name.replace('Sync', '')}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  await withTenant({ orgId: c.orgId, userId: c.userId }, (q) =>
    q.exec(`update integration_connections set last_sync_at=now(), status_detail=$2 where id=$1`, [conn.id, res.errors.length ? res.errors.join(' · ').slice(0, 500) : null]),
  );
  return res;
}

/** Cron tick: sync every connected Google/Microsoft account (bounded per tick). */
/** Cron tick: enqueue one sync job per due connection (skipped while one is already queued or running). */
export async function runDueSyncs(limit = 20) {
  const due = await withTenant({ orgId: null, userId: 'system:sync' }, (q) => q.many('select * from qline_due_syncs() limit $1', [limit]));
  let queued = 0;
  const bucket = new Date(Math.floor(Date.now() / 600_000) * 600_000).toISOString();
  for (const d of due) {
    const created = await withTenant({ orgId: d.org_id, userId: d.connected_by }, async (q) => {
      const busy = await q.one(`select 1 from jobs where kind='integration.sync' and status in ('queued','running') and payload->>'connectionId'=$1`, [d.connection_id]);
      if (busy) return false;
      const j = await enqueue(q, {
        orgId: d.org_id,
        kind: 'integration.sync',
        payload: { connectionId: d.connection_id, workspaceId: d.workspace_id, userId: d.connected_by },
        idempotencyKey: `sync:${d.connection_id}:${bucket}`,
        maxAttempts: 3,
        createdBy: 'system:sync',
      });
      return j.created;
    });
    if (created) queued += 1;
  }
  return { queued };
}

registerJob('integration.sync', async ({ job }) => {
  const p = job.payload;
  const r = await syncConnection({ orgId: job.org_id, workspaceId: p.workspaceId, userId: p.userId }, p.connectionId);
  return { leads: r.leads };
});
