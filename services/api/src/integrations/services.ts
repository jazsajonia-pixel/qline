import { api } from './oauth';

/** Thin, typed wrappers over the provider REST APIs Qline uses. All calls use the caller's token. */

export interface InboundMail {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  text: string;
  receivedAt: Date;
  bulk: boolean; // newsletter / automated (List-Unsubscribe, Precedence: bulk, no-reply)
}

function parseFrom(v: string | undefined) {
  if (!v) return { email: null, name: null };
  const m = v.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (m) return { name: m[1]!.trim() || null, email: m[2]!.trim().toLowerCase() };
  return { name: null, email: v.trim().toLowerCase() };
}

function b64url(s: string) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function stripHtml(h: string) {
  return h
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const NOREPLY = /(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce)@/i;

// ---- Gmail ----------------------------------------------------------------------------
export async function gmailNewMessages(token: string, afterEpochSec: number, max = 15): Promise<InboundMail[]> {
  const qs = `in:inbox -category:promotions -category:social -category:forums after:${afterEpochSec}`;
  const list = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(qs)}`);
  const out: InboundMail[] = [];
  for (const m of list.messages ?? []) {
    const full = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
    const headers: Record<string, string> = {};
    for (const h of full.payload?.headers ?? []) headers[String(h.name).toLowerCase()] = h.value;
    const from = parseFrom(headers['from']);
    let plain = '';
    let html = '';
    const walk = (p: any) => {
      if (!p) return;
      if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64url(p.body.data);
      if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64url(p.body.data);
      for (const c of p.parts ?? []) walk(c);
    };
    walk(full.payload);
    const text = (plain || stripHtml(html) || full.snippet || '').slice(0, 4000);
    out.push({
      id: m.id,
      fromEmail: from.email,
      fromName: from.name,
      subject: headers['subject'] ?? '(no subject)',
      text,
      receivedAt: new Date(Number(full.internalDate ?? Date.now())),
      bulk: !!headers['list-unsubscribe'] || /bulk|list|junk/i.test(headers['precedence'] ?? '') || NOREPLY.test(from.email ?? ''),
    });
  }
  return out;
}

/** Search results with headers + snippet only (format=metadata keeps it light). */
export async function gmailSearch(token: string, query: string, max = 8) {
  const list = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`);
  const out: { id: string; from: string | null; subject: string; date: string | null; snippet: string; unread: boolean }[] = [];
  for (const m of list.messages ?? []) {
    const r = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    const h: Record<string, string> = {};
    for (const x of r.payload?.headers ?? []) h[String(x.name).toLowerCase()] = x.value;
    out.push({ id: m.id, from: h['from'] ?? null, subject: h['subject'] ?? '(no subject)', date: h['date'] ?? null, snippet: String(r.snippet ?? '').slice(0, 300), unread: (r.labelIds ?? []).includes('UNREAD') });
  }
  return out;
}

export async function gmailMessage(token: string, id: string) {
  const full = await api(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
  const h: Record<string, string> = {};
  for (const x of full.payload?.headers ?? []) h[String(x.name).toLowerCase()] = x.value;
  let plain = '';
  let html = '';
  const walk = (p: any) => {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && !plain) plain = b64url(p.body.data);
    if (p.mimeType === 'text/html' && p.body?.data && !html) html = b64url(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(full.payload);
  return { id, from: h['from'] ?? null, to: h['to'] ?? null, subject: h['subject'] ?? '(no subject)', date: h['date'] ?? null, text: (plain || stripHtml(html) || full.snippet || '').slice(0, 4000) };
}

export async function outlookSearch(token: string, query: string, max = 8) {
  const plain = query.replace(/\b(in|is|newer_than|older_than|label|category):\S+/g, ' ').replace(/\s+/g, ' ').trim();
  const url = plain
    ? `https://graph.microsoft.com/v1.0/me/messages?$top=${max}&$search=${encodeURIComponent(`"${plain.replace(/"/g, '')}"`)}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`
    : `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${max}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`;
  const r = await api(token, url);
  return (r.value ?? []).map((m: any) => ({ id: m.id, from: m.from?.emailAddress?.address ?? null, subject: m.subject ?? '(no subject)', date: m.receivedDateTime, snippet: String(m.bodyPreview ?? '').slice(0, 300), unread: !m.isRead }));
}

function mime(to: string, subject: string, body: string, from?: string | null) {
  const enc = (s: string) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  return [from ? `From: ${from}` : null, `To: ${to}`, `Subject: ${enc(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', body]
    .filter((l) => l !== null)
    .join('\r\n');
}

export async function gmailSend(token: string, to: string, subject: string, body: string) {
  const raw = Buffer.from(mime(to, subject, body)).toString('base64url');
  return api(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { body: { raw } });
}

// ---- Outlook (Microsoft Graph) ----------------------------------------------------------
export async function outlookNewMessages(token: string, afterIso: string, max = 15): Promise<InboundMail[]> {
  const url =
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${max}&$orderby=receivedDateTime desc` +
    `&$filter=${encodeURIComponent(`receivedDateTime gt ${afterIso}`)}&$select=id,subject,from,receivedDateTime,body,internetMessageHeaders,inferenceClassification`;
  const r = await api(token, url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
  return (r.value ?? []).map((m: any) => {
    const headers: Record<string, string> = {};
    for (const h of m.internetMessageHeaders ?? []) headers[String(h.name).toLowerCase()] = h.value;
    const email = m.from?.emailAddress?.address?.toLowerCase() ?? null;
    return {
      id: m.id,
      fromEmail: email,
      fromName: m.from?.emailAddress?.name ?? null,
      subject: m.subject ?? '(no subject)',
      text: String(m.body?.content ?? '').slice(0, 4000),
      receivedAt: new Date(m.receivedDateTime),
      bulk: !!headers['list-unsubscribe'] || m.inferenceClassification === 'other' || NOREPLY.test(email ?? ''),
    } satisfies InboundMail;
  });
}

export async function outlookSend(token: string, to: string, subject: string, body: string) {
  return api(token, 'https://graph.microsoft.com/v1.0/me/sendMail', {
    body: { message: { subject, body: { contentType: 'Text', content: body }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true },
  });
}

// ---- Calendar (Google + Microsoft) --------------------------------------------------------
export async function createCalendarEvent(provider: 'google' | 'microsoft', token: string, ev: { title: string; start: Date; minutes: number; description?: string }) {
  const end = new Date(ev.start.getTime() + ev.minutes * 60_000);
  if (provider === 'google') {
    const r = await api(token, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      body: { summary: ev.title, description: ev.description, start: { dateTime: ev.start.toISOString() }, end: { dateTime: end.toISOString() } },
    });
    return { id: r.id as string, url: r.htmlLink as string };
  }
  const r = await api(token, 'https://graph.microsoft.com/v1.0/me/events', {
    body: { subject: ev.title, body: { contentType: 'Text', content: ev.description ?? '' }, start: { dateTime: ev.start.toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: end.toISOString().slice(0, 19), timeZone: 'UTC' } },
  });
  return { id: r.id as string, url: r.webLink as string };
}

export async function upcomingEvents(provider: 'google' | 'microsoft', token: string, days = 7) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);
  if (provider === 'google') {
    const r = await api(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=20&timeMin=${now.toISOString()}&timeMax=${until.toISOString()}`);
    return (r.items ?? []).map((e: any) => ({ id: e.id, title: e.summary ?? '(busy)', start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, url: e.htmlLink, provider }));
  }
  const r = await api(token, `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${until.toISOString()}&$top=20&$orderby=start/dateTime&$select=id,subject,start,end,webLink`);
  return (r.value ?? []).map((e: any) => ({ id: e.id, title: e.subject ?? '(busy)', start: e.start?.dateTime + 'Z', end: e.end?.dateTime + 'Z', url: e.webLink, provider }));
}

// ---- Google Sheets ------------------------------------------------------------------------
export const SHEET_HEADER = ['Qline ID', 'Name', 'Email', 'Phone', 'Company / title', 'Stage', 'Urgency', 'Summary', 'Source', 'Added'];

export async function sheetCreate(token: string, title: string) {
  const r = await api(token, 'https://sheets.googleapis.com/v4/spreadsheets', {
    body: { properties: { title }, sheets: [{ properties: { title: 'Leads', gridProperties: { frozenRowCount: 1 } } }] },
  });
  await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${r.spreadsheetId}/values/Leads!A1:J1?valueInputOption=RAW`, { method: 'PUT', body: { values: [SHEET_HEADER] } });
  return { id: r.spreadsheetId as string, url: r.spreadsheetUrl as string };
}

export async function sheetRows(token: string, id: string): Promise<string[][]> {
  const r = await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Leads!A2:J2000`);
  return (r.values ?? []) as string[][];
}

export async function sheetAppend(token: string, id: string, rows: string[][]) {
  if (!rows.length) return;
  await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Leads!A1:J1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { body: { values: rows } });
}

export async function sheetSetCell(token: string, id: string, a1: string, value: string) {
  await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/Leads!${a1}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[value]] } });
}

// ---- Google Forms ---------------------------------------------------------------------------
const FORM_FIELDS: { key: string; title: string; required: boolean; paragraph?: boolean }[] = [
  { key: 'name', title: 'Your name', required: true },
  { key: 'email', title: 'Email', required: true },
  { key: 'phone', title: 'Phone', required: false },
  { key: 'company', title: 'Company', required: false },
  { key: 'message', title: 'How can we help?', required: true, paragraph: true },
];

export async function formCreate(token: string, title: string, description: string) {
  const f = await api(token, 'https://forms.googleapis.com/v1/forms', { body: { info: { title, documentTitle: title } } });
  const requests: any[] = [{ updateFormInfo: { info: { description }, updateMask: 'description' } }];
  FORM_FIELDS.forEach((x, i) =>
    requests.push({
      createItem: { item: { title: x.title, questionItem: { question: { required: x.required, textQuestion: { paragraph: !!x.paragraph } } } }, location: { index: i } },
    }),
  );
  await api(token, `https://forms.googleapis.com/v1/forms/${f.formId}:batchUpdate`, { body: { requests } });
  try {
    // Forms created through the API may start unpublished.
    await api(token, `https://forms.googleapis.com/v1/forms/${f.formId}:setPublishSettings`, {
      body: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } }, updateMask: '*' },
    });
  } catch {
    /* older forms are published by default */
  }
  const full = await api(token, `https://forms.googleapis.com/v1/forms/${f.formId}`);
  const questions: Record<string, string> = {};
  for (const it of full.items ?? []) {
    const k = FORM_FIELDS.find((x) => x.title === it.title)?.key;
    const qid = it.questionItem?.question?.questionId;
    if (k && qid) questions[k] = qid;
  }
  return { id: f.formId as string, responderUri: (full.responderUri ?? f.responderUri) as string, editUrl: `https://docs.google.com/forms/d/${f.formId}/edit`, questions };
}

export interface FormQuestion {
  title: string;
  type: 'short' | 'paragraph' | 'multiple_choice' | 'checkboxes' | 'dropdown' | 'date' | 'scale';
  required?: boolean;
  options?: string[];
}

/** The Forms API body for one question. Exported for tests. */
export function formQuestionBody(x: FormQuestion) {
  const choice = { multiple_choice: 'RADIO', checkboxes: 'CHECKBOX', dropdown: 'DROP_DOWN' } as const;
  const base = { required: !!x.required };
  if (x.type in choice) {
    const opts = (x.options?.length ? x.options : ['Option 1']).slice(0, 30).map((value) => ({ value }));
    return { ...base, choiceQuestion: { type: choice[x.type as keyof typeof choice], options: opts } };
  }
  if (x.type === 'date') return { ...base, dateQuestion: { includeYear: true } };
  if (x.type === 'scale') return { ...base, scaleQuestion: { low: 1, high: 5, lowLabel: 'Low', highLabel: 'High' } };
  return { ...base, textQuestion: { paragraph: x.type === 'paragraph' } };
}

/** Creates and publishes a Google Form with any questions. */
export async function formCreateCustom(token: string, title: string, description: string, questions: FormQuestion[]) {
  const f = await api(token, 'https://forms.googleapis.com/v1/forms', { body: { info: { title, documentTitle: title } } });
  const requests: any[] = [];
  if (description) requests.push({ updateFormInfo: { info: { description }, updateMask: 'description' } });
  questions.forEach((x, i) => requests.push({ createItem: { item: { title: x.title, questionItem: { question: formQuestionBody(x) } }, location: { index: i } } }));
  await api(token, `https://forms.googleapis.com/v1/forms/${f.formId}:batchUpdate`, { body: { requests } });
  try {
    await api(token, `https://forms.googleapis.com/v1/forms/${f.formId}:setPublishSettings`, {
      body: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } }, updateMask: '*' },
    });
  } catch {
    /* older forms are published by default */
  }
  const full = await api(token, `https://forms.googleapis.com/v1/forms/${f.formId}`);
  return { id: f.formId as string, responderUri: (full.responderUri ?? f.responderUri) as string, editUrl: `https://docs.google.com/forms/d/${f.formId}/edit` };
}

/** Responses with answers keyed by question title. */
export async function formResponsesReadable(token: string, id: string, limit = 20) {
  const form = await api(token, `https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}`);
  const titles: Record<string, string> = {};
  for (const it of form.items ?? []) {
    const qid = it.questionItem?.question?.questionId;
    if (qid) titles[qid] = it.title;
  }
  const r = await api(token, `https://forms.googleapis.com/v1/forms/${encodeURIComponent(id)}/responses`);
  return ((r.responses ?? []) as any[])
    .sort((a, b) => String(b.lastSubmittedTime).localeCompare(String(a.lastSubmittedTime)))
    .slice(0, limit)
    .map((x) => ({
      submittedAt: x.lastSubmittedTime,
      email: x.respondentEmail ?? null,
      answers: Object.fromEntries(Object.entries(x.answers ?? {}).map(([qid, v]: [string, any]) => [titles[qid] ?? qid, (v.textAnswers?.answers ?? []).map((t: any) => t.value).join(', ')])),
    }));
}

/** A spreadsheet with custom headers and rows. */
export async function sheetCreateCustom(token: string, title: string, headers: string[], rows: string[][]) {
  const r = await api(token, 'https://sheets.googleapis.com/v4/spreadsheets', {
    body: { properties: { title }, sheets: [{ properties: { title: 'Sheet1', gridProperties: { frozenRowCount: 1 } } }] },
  });
  await api(token, `https://sheets.googleapis.com/v4/spreadsheets/${r.spreadsheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: [headers, ...rows] } });
  return { id: r.spreadsheetId as string, url: r.spreadsheetUrl as string };
}

export async function formResponses(token: string, id: string, afterIso: string | null) {
  const filter = afterIso ? `?filter=${encodeURIComponent(`timestamp > ${afterIso}`)}` : '';
  const r = await api(token, `https://forms.googleapis.com/v1/forms/${id}/responses${filter}`);
  return (r.responses ?? []) as any[];
}

// ---- Slack ------------------------------------------------------------------------------------
/**
 * Slack treats `<...>` as control syntax (`<!channel>`, `<@U123>`, `<https://x|label>`), so text from
 * emails, forms or a model could ping everyone or disguise a link. Escape &, < and > (Slack's documented rule).
 */
export const slackEscape = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Slack errors that mean the connection itself is gone, so the user has to reconnect. */
const SLACK_GONE = new Set(['token_revoked', 'invalid_auth', 'account_inactive', 'not_authed', 'token_expired', 'team_access_not_granted']);
const SLACK_HINT: Record<string, string> = {
  channel_not_found: 'That Slack channel no longer exists or is private. Pick another channel in Settings → Integrations → Slack.',
  is_archived: 'That Slack channel is archived. Pick another channel in Settings → Integrations → Slack.',
  not_in_channel: 'Qline is not in that channel. Invite the Qline app to it, or pick a public channel.',
  restricted_action: 'Your Slack workspace does not allow apps to post in that channel.',
  missing_scope: 'Qline is missing a Slack permission. Reconnect Slack in Settings → Integrations.',
  ratelimited: 'Slack is rate-limiting Qline. Try again in a minute.',
  msg_too_long: 'The message is too long for Slack.',
};
function slackError(e: unknown): Error {
  const code = (e as Error).message;
  if (SLACK_GONE.has(code)) return Object.assign(new Error(`Slack removed Qline's access (${code}). Reconnect Slack in Settings → Integrations.`), { status: 401, slack: code });
  return Object.assign(new Error(SLACK_HINT[code] ? `${SLACK_HINT[code]} (${code})` : `Slack error: ${code}`), { status: (e as any).status, slack: code });
}

export async function slackChannels(token: string) {
  const out: { id: string; name: string }[] = [];
  let cursor = '';
  // Page through (Slack returns at most 1000 per page; stop at 2000 to bound the call).
  for (let page = 0; page < 10 && out.length < 2000; page++) {
    const r = await api(token, `https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).catch((e) => {
      throw slackError(e);
    });
    for (const c of r.channels ?? []) out.push({ id: c.id as string, name: c.name as string });
    cursor = r.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Posts `text` escaped. Pass `{ formatted: true }` only for text Qline built itself with escaped parts. */
export async function slackPost(token: string, channel: string, text: string, opts: { formatted?: boolean } = {}) {
  return api(token, 'https://slack.com/api/chat.postMessage', { body: { channel, text: opts.formatted ? text : slackEscape(text), unfurl_links: false, unfurl_media: false } }).catch((e) => {
    throw slackError(e);
  });
}

export async function slackRevoke(token: string) {
  await api(token, 'https://slack.com/api/auth.revoke', { body: {} }).catch(() => undefined);
}
