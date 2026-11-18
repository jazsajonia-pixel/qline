import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit';
import { publish } from '../core/events';
import type { Q } from '../core/db';
import { fieldsFor, importParsed, TARGETS, type Target } from '../modules/imports';
import { fail } from './tools-apps';
import type { Artifact, ToolDef } from './tools';

/**
 * v1.6 run 2 tools: work with files sent in chat, and show charts and images in the reply.
 * Charts of Qline data are computed here (chart.business) so the numbers are real; chart.create only
 * draws numbers the model already got from a tool or a file, and it must say where they came from.
 */

const fileRow = (q: Q, id: string) => q.one('select id, name, mime, extracted, created_at from files where id=$1', [id]);

export const FILE_PAGE_CHARS = 8000;
export const FILE_PAGE_ROWS = 50;

/** Server-computed charts. Each returns labels plus one or more series from the workspace's own data. */
export const BUSINESS_METRICS = {
  leads_per_day: 'Leads received per day',
  leads_by_source: 'Leads by source',
  leads_by_urgency: 'Leads by urgency',
  tasks_by_status: 'Open and finished tasks by status',
  tasks_by_priority: 'Open tasks by priority',
  tasks_completed_per_week: 'Tasks completed per week',
  contacts_by_stage: 'Contacts by stage',
  contacts_added_per_week: 'Contacts added per week',
  ai_tokens_per_day: 'AI tokens used per day',
} as const;
export type BusinessMetric = keyof typeof BUSINESS_METRICS;

const day = (d: string | Date) => new Date(d).toISOString().slice(5, 10); // MM-DD

export async function businessChart(q: Q, workspaceId: string, metric: BusinessMetric, days: number): Promise<Artifact> {
  const n = (x: unknown) => Number(x ?? 0);
  const base = { type: 'chart' as const, title: BUSINESS_METRICS[metric], source: 'Qline data', computed: true };
  const perDay = async (sql: string) => {
    const rows = await q.many(
      `with d as (select generate_series((current_date - ($2::int - 1)), current_date, interval '1 day')::date as day)
       select d.day, coalesce(x.n, 0) as n from d left join (${sql}) x on x.day = d.day order by d.day`,
      [workspaceId, days],
    );
    return { labels: rows.map((r: any) => day(r.day)), values: rows.map((r: any) => n(r.n)) };
  };
  const perWeek = async (sql: string, weeks: number) => {
    const rows = await q.many(
      `with w as (select generate_series(date_trunc('week', current_date) - (($2::int - 1) * interval '1 week'), date_trunc('week', current_date), interval '1 week')::date as wk)
       select w.wk, coalesce(x.n, 0) as n from w left join (${sql}) x on x.wk = w.wk order by w.wk`,
      [workspaceId, weeks],
    );
    return { labels: rows.map((r: any) => `wk ${day(r.wk)}`), values: rows.map((r: any) => n(r.n)) };
  };
  const grouped = async (sql: string) => {
    const rows = await q.many(sql, [workspaceId]);
    return { labels: rows.map((r: any) => String(r.k)), values: rows.map((r: any) => n(r.n)) };
  };
  const weeks = Math.max(2, Math.min(26, Math.ceil(days / 7)));
  switch (metric) {
    case 'leads_per_day': {
      const s = await perDay(`select coalesce(received_at, created_at)::date as day, count(*) as n from lead_inbox where workspace_id=$1 and is_lead group by 1`);
      return { ...base, chart: 'line', labels: s.labels, series: [{ name: 'Leads', values: s.values }], title: `${base.title} (last ${days} days)` };
    }
    case 'leads_by_source': {
      const s = await grouped(`select source as k, count(*) as n from lead_inbox where workspace_id=$1 and is_lead and coalesce(received_at, created_at) > now() - interval '90 days' group by 1 order by 2 desc`);
      return { ...base, chart: 'pie', labels: s.labels, series: [{ name: 'Leads', values: s.values }], title: `${base.title} (last 90 days)` };
    }
    case 'leads_by_urgency': {
      const s = await grouped(
        `select coalesce(urgency, 'normal') as k, count(*) as n from lead_inbox where workspace_id=$1 and is_lead and coalesce(received_at, created_at) > now() - interval '30 days'
         group by 1 order by array_position(array['urgent','high','normal','low'], coalesce(urgency, 'normal'))`,
      );
      return { ...base, chart: 'bar', labels: s.labels, series: [{ name: 'Leads', values: s.values }], title: `${base.title} (last 30 days)` };
    }
    case 'tasks_by_status': {
      const s = await grouped(`select status as k, count(*) as n from tasks where workspace_id=$1 and deleted_at is null group by 1 order by 2 desc limit 12`);
      return { ...base, chart: 'bar', labels: s.labels, series: [{ name: 'Tasks', values: s.values }] };
    }
    case 'tasks_by_priority': {
      const s = await grouped(
        `select priority as k, count(*) as n from tasks where workspace_id=$1 and deleted_at is null and status <> 'done'
         group by 1 order by array_position(array['urgent','high','normal','low'], priority)`,
      );
      return { ...base, chart: 'bar', labels: s.labels, series: [{ name: 'Open tasks', values: s.values }] };
    }
    case 'tasks_completed_per_week': {
      const s = await perWeek(`select date_trunc('week', completed_at)::date as wk, count(*) as n from tasks where workspace_id=$1 and deleted_at is null and completed_at is not null group by 1`, weeks);
      return { ...base, chart: 'bar', labels: s.labels, series: [{ name: 'Completed', values: s.values }] };
    }
    case 'contacts_by_stage': {
      const s = await grouped(`select coalesce(nullif(stage, ''), 'none') as k, count(*) as n from contacts where workspace_id=$1 and deleted_at is null group by 1 order by 2 desc limit 10`);
      return { ...base, chart: 'pie', labels: s.labels, series: [{ name: 'Contacts', values: s.values }] };
    }
    case 'contacts_added_per_week': {
      const s = await perWeek(`select date_trunc('week', created_at)::date as wk, count(*) as n from contacts where workspace_id=$1 and deleted_at is null group by 1`, weeks);
      return { ...base, chart: 'line', labels: s.labels, series: [{ name: 'New contacts', values: s.values }] };
    }
    case 'ai_tokens_per_day': {
      const s = await perDay(
        `select r.created_at::date as day, sum(r.input_tokens + r.output_tokens) as n from agent_runs r join agents a on a.id = r.agent_id where a.workspace_id=$1 group by 1`,
      );
      return { ...base, chart: 'bar', labels: s.labels, series: [{ name: 'Tokens', values: s.values }], title: `${base.title} (last ${days} days)` };
    }
  }
}

function renderRecords(columns: string[], rows: Record<string, string>[]) {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.map(esc).join(','), ...rows.map((r) => columns.map((c) => esc(String(r[c] ?? ''))).join(','))].join('\n');
}

export const fileTools = {
  'files.read': {
    description: 'Read a file the user sent in chat (or an imported file): text in pages of 8000 characters, or spreadsheet rows in pages of 50.',
    schema: z.object({ fileId: z.string().uuid(), offset: z.number().int().min(0).max(1_000_000).optional().describe('Character offset for text, row offset for spreadsheets') }),
    async execute(q, _ctx, a) {
      const f = await fileRow(q, a.fileId);
      if (!f) return fail('File not found');
      const e = f.extracted ?? {};
      const off = a.offset ?? 0;
      const ref = [{ type: 'file', id: f.id, title: f.name }];
      if (e.kind === 'image') return { ok: true, summary: `${f.name} is an image`, refs: ref, data: { kind: 'image', note: 'Images are shown to the model with the message they were sent in. Use image.show to display it.' } };
      if (e.kind === 'records') {
        const rows = (e.rows ?? []).slice(off, off + FILE_PAGE_ROWS);
        const next = off + rows.length < (e.rows?.length ?? 0) ? off + rows.length : null;
        return { ok: true, summary: `${f.name}: rows ${off + 1}–${off + rows.length} of ${e.rowCount}`, refs: ref, data: { kind: 'records', columns: e.columns, rowCount: e.rowCount, rows, nextOffset: next, readable: e.rows?.length ?? 0 } };
      }
      if (e.kind === 'document') {
        const text = String(e.text ?? '').slice(off, off + FILE_PAGE_CHARS);
        const next = off + text.length < String(e.text ?? '').length ? off + text.length : null;
        return { ok: true, summary: `${f.name}: characters ${off}–${off + text.length} of ${e.chars}`, refs: ref, data: { kind: 'document', text, nextOffset: next, truncated: !!e.truncated } };
      }
      return fail('This file was not prepared for reading. Ask the user to send it again in chat.');
    },
    preview: (a) => ({ title: 'Read file', lines: [a.fileId] }),
  } satisfies ToolDef<any>,

  'files.save_to_library': {
    description: 'Save a file the user sent (document text, or spreadsheet rows as CSV) as a Library document so it can be searched later.',
    schema: z.object({ fileId: z.string().uuid(), title: z.string().trim().min(1).max(200).optional(), folder: z.string().trim().max(80).optional() }),
    async execute(q, ctx, a) {
      const f = await fileRow(q, a.fileId);
      if (!f) return fail('File not found');
      const e = f.extracted ?? {};
      if (e.kind !== 'document' && e.kind !== 'records') return fail('Only documents and spreadsheets can be saved to the Library.');
      const body = e.kind === 'document' ? String(e.text ?? '') : renderRecords(e.columns ?? [], e.rows ?? []);
      const title = a.title ?? f.name.replace(/\.[^.]+$/, '');
      const d = await q.one(
        `insert into documents (org_id, workspace_id, file_id, kind, title, body, folder, source_kind, source_ref, created_by) values ($1,$2,$3,'document',$4,$5,$6,'agent',$7,$8) returning id, title`,
        [ctx.orgId, ctx.workspaceId, f.id, title, body, a.folder ?? 'From chat', `file:${f.id}`, `${ctx.actor.kind}:${ctx.actor.id}`],
      );
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'document.created', targetRef: `document:${d.id}`, detail: { fromFile: f.id, truncated: !!e.truncated } });
      return { ok: true, summary: `Saved "${d.title}" to the Library${e.truncated ? ' (first part only; the file was very long)' : ''}`, refs: [{ type: 'document', id: d.id, title: d.title }] };
    },
    preview: (a) => ({ title: 'Save file to the Library', lines: [a.title ?? a.fileId, a.folder ? `Folder: ${a.folder}` : 'Folder: From chat'] }),
  } satisfies ToolDef<any>,

  'files.import_records': {
    description:
      'Import the rows of a spreadsheet the user sent (CSV, XLSX, JSON) as contacts, companies or tasks. Duplicates (same email / company name) are skipped. The import shows in Imports and can be rolled back there.',
    schema: z.object({
      fileId: z.string().uuid(),
      target: z.enum(['contacts', 'companies', 'tasks']),
      fields: z.record(z.string(), z.string()).optional().describe('Optional mapping {qlineField: columnName}; otherwise columns are matched by name'),
    }),
    async execute(q, ctx, a) {
      const f = await fileRow(q, a.fileId);
      if (!f) return fail('File not found');
      const e = f.extracted ?? {};
      if (e.kind !== 'records') return fail('Only spreadsheets (CSV, XLSX, JSON) can be imported as records.');
      if (e.truncated) return fail(`This file has ${e.rowCount} rows; the AI can import up to 500. Use Import in the app for larger files.`);
      const target = a.target as Target;
      const columns: string[] = (e.columns ?? []) as string[];
      const allowed = TARGETS[target] as readonly string[];
      const fields = a.fields ? Object.fromEntries(Object.entries(a.fields as Record<string, string>).filter(([k, v]) => allowed.includes(k) && columns.includes(v))) : fieldsFor(columns, target);
      const key = target === 'tasks' ? 'title' : 'name';
      if (!fields[key]) return fail(`No column for ${key}. Columns are: ${columns.join(', ')}`);
      const mapping = { target, fields, duplicates: 'skip' as const };
      const jobId = randomUUID();
      await q.exec(
        `insert into import_jobs (id, org_id, workspace_id, file_id, format, detected_entity, target_entity, columns, preview, mapping, rows_total, status, created_by)
         values ($1,$2,$3,$4,$11,$5,$5,$6,$7,$8,$9,'running',$10)`,
        [jobId, ctx.orgId, ctx.workspaceId, f.id, target, JSON.stringify(columns), JSON.stringify((e.rows ?? []).slice(0, 10)), JSON.stringify(mapping), e.rowCount ?? 0, ctx.userId, (['csv', 'xlsx', 'json'].find((x) => f.name.toLowerCase().endsWith(`.${x}`)) ?? 'csv')],
      );
      const parsed = { kind: 'records' as const, columns, rows: e.rows ?? [] };
      const r = await importParsed(q, ctx, ctx.actor.kind === 'agent' ? { kind: 'agent', id: ctx.actor.id } : { kind: 'user', id: ctx.actor.id }, { id: jobId, file_id: f.id, file_name: f.name, mapping }, parsed);
      await q.exec(`update import_jobs set status='completed', rows_ok=$2, rows_skipped=$3, rows_failed=$4, errors=$5, completed_at=now() where id=$1`, [jobId, r.ok, r.skipped, r.errors.length, JSON.stringify(r.errors)]);
      // Same transaction as the rows, so the event exists only if the import does (the outbox relay delivers it).
      await publish(q, { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId }, [{ type: 'import.completed', id: `import:${jobId}`, data: { importId: jobId, target, ok: r.ok } }]);
      return {
        ok: r.ok > 0 || r.skipped > 0,
        summary: `Imported ${r.ok} ${target}${r.skipped ? `, skipped ${r.skipped} duplicates` : ''}${r.errors.length ? `, ${r.errors.length} rows had problems` : ''}. Undo in Imports if needed.`,
        refs: [{ type: 'import', id: jobId, title: f.name }],
        data: { imported: r.ok, skipped: r.skipped, problems: r.errors.slice(0, 5), mapping: fields },
      };
    },
    preview: (a) => ({ title: `Import rows as ${a.target}`, lines: [`File: ${a.fileId}`, a.fields ? `Mapping: ${JSON.stringify(a.fields)}` : 'Columns matched by name', 'Can be rolled back in Imports'] }),
  } satisfies ToolDef<any>,

  'chart.business': {
    description: `Show a chart of this workspace's data in the chat. Qline computes the numbers. Metrics: ${Object.entries(BUSINESS_METRICS)
      .map(([k, v]) => `${k} (${v})`)
      .join('; ')}.`,
    schema: z.object({ metric: z.enum(Object.keys(BUSINESS_METRICS) as [BusinessMetric, ...BusinessMetric[]]), days: z.number().int().min(7).max(180).optional() }),
    async execute(q, ctx, a) {
      const chart = await businessChart(q, ctx.workspaceId, a.metric, a.days ?? 30);
      if (chart.type !== 'chart') return fail('No chart');
      const total = chart.series[0]!.values.reduce((s, v) => s + v, 0);
      return { ok: true, summary: `Showing "${chart.title}" (${total} in total)`, refs: [], data: { labels: chart.labels, series: chart.series }, artifacts: [chart] };
    },
    preview: (a) => ({ title: 'Show chart', lines: [BUSINESS_METRICS[a.metric as BusinessMetric]] }),
  } satisfies ToolDef<any>,

  'chart.create': {
    description:
      'Draw a chart in the chat from numbers you already got from a tool result or an attached file (for example a Google Sheet). Never invent or estimate numbers. Say where they came from in `source`.',
    schema: z
      .object({
        chart: z.enum(['bar', 'line', 'pie']),
        title: z.string().trim().min(1).max(120),
        labels: z.array(z.string().max(40)).min(1).max(40),
        series: z.array(z.object({ name: z.string().max(40), values: z.array(z.number().finite()) })).min(1).max(4),
        unit: z.string().max(12).optional(),
        source: z.string().trim().min(3).max(120).describe('Where the numbers came from, e.g. "Sheet: Sales 2026, tab Q3"'),
      })
      .refine((c) => c.series.every((s) => s.values.length === c.labels.length), { message: 'Each series needs one value per label' })
      .refine((c) => c.chart !== 'pie' || (c.series.length === 1 && c.series[0]!.values.every((v) => v >= 0)), { message: 'A pie chart takes one series of non-negative values' }),
    async execute(_q, _ctx, a) {
      const chart: Artifact = { type: 'chart', chart: a.chart, title: a.title, labels: a.labels, series: a.series, unit: a.unit, source: a.source, computed: false };
      return { ok: true, summary: `Showing "${a.title}"`, refs: [], artifacts: [chart] };
    },
    preview: (a) => ({ title: 'Show chart', lines: [a.title, `Source: ${a.source}`] }),
  } satisfies ToolDef<any>,

  'image.show': {
    description: 'Show an image the user sent earlier (by fileId) in the chat, with an optional caption.',
    schema: z.object({ fileId: z.string().uuid(), caption: z.string().max(200).optional() }),
    async execute(q, _ctx, a) {
      const f = await fileRow(q, a.fileId);
      if (!f) return fail('Image not found');
      if (!String(f.mime).startsWith('image/')) return fail('That file is not an image.');
      return { ok: true, summary: `Showing ${f.name}`, refs: [{ type: 'file', id: f.id, title: f.name }], artifacts: [{ type: 'image', fileId: f.id, name: f.name, caption: a.caption }] };
    },
    preview: (a) => ({ title: 'Show image', lines: [a.caption ?? a.fileId] }),
  } satisfies ToolDef<any>,
};
