import { Hono } from 'hono';
import { z } from 'zod';
import { complete, extractJson, ProviderError } from '@qline/ai';
import { resolveModel } from '../agent/models';
import { audit } from '../core/audit';
import { need, requireTenant, requireUser, tx, type Env, type TenantCtx } from '../core/context';
import type { Q } from '../core/db';
import { env } from '../core/env';
import { ApiError, notFound } from '../core/errors';
import { body } from '../core/validate';
import { DEFAULT_CONFIG, NEW_CLIENT_WORKFLOW } from './templates';

// ---------------------------------------------------------------------------
// Interview (docs/08 §1: ≤ 12 core questions, each tagged with what it affects)
// ---------------------------------------------------------------------------
export const QUESTIONS = [
  { id: 'businessName', text: 'What is your business called?', kind: 'text', affects: ['profile.businessName'] },
  {
    id: 'businessType',
    text: 'What kind of business is it?',
    kind: 'choice',
    options: ['Agency / studio', 'Professional services', 'Retail / e-commerce', 'Software / SaaS', 'Consulting / coaching', 'Other'],
    affects: ['terminology', 'modules'],
  },
  { id: 'offerings', text: 'What do you sell? List your main products or services.', kind: 'text', affects: ['profile.offerings'] },
  { id: 'clients', text: 'Who are your clients?', kind: 'choice', options: ['Businesses (B2B)', 'Consumers (B2C)', 'Both'], affects: ['terminology.client'] },
  { id: 'teamSize', text: 'How many people work in the business, including you?', kind: 'choice', options: ['Just me', '2–5', '6–20', '21+'], affects: ['agents', 'roles'] },
  { id: 'salesStages', text: 'How does a new client move from first contact to paying? Name the steps.', kind: 'text', affects: ['pipelineStages'] },
  { id: 'taskStages', text: 'How do you track work? Name the stages a task goes through.', kind: 'text', affects: ['taskStatuses'] },
  { id: 'tools', text: 'Which tools do you use today? (e.g. Gmail, Google Drive, Slack, spreadsheets)', kind: 'text', affects: ['integrationsSuggested'] },
  { id: 'goals', text: 'What are your top goals for the next 3 months?', kind: 'text', affects: ['profile.goals'] },
  { id: 'metrics', text: 'Which numbers tell you the business is healthy?', kind: 'text', affects: ['profile.metrics'] },
  { id: 'pains', text: 'What slows you down the most right now?', kind: 'text', affects: ['agents', 'workflows'] },
  { id: 'aiComfort', text: 'How much should AI do on its own?', kind: 'choice', options: ['Always ask me first', 'Small internal tasks are fine', 'Not sure yet'], affects: ['agentPolicy'] },
] as const;

type Answers = Record<string, { value: string; at: string; unknown?: boolean }>;

interface Field<T> {
  value: T;
  source: 'answer' | 'rules' | 'ai' | 'default';
  confidence: number;
}
export interface BusinessModel {
  businessName: Field<string | null>;
  businessType: Field<string>;
  clientWord: Field<string>;
  offerings: Field<string[]>;
  teamSize: Field<string>;
  pipelineStages: Field<string[]>;
  taskStatuses: Field<string[]>;
  tools: Field<string[]>;
  goals: Field<string[]>;
  metrics: Field<string[]>;
  pains: Field<string[]>;
  aiAutonomy: Field<'ask' | 'internal_ok'>;
  recommendedAgents: Field<string[]>;
}

const splitList = (s?: string) =>
  (s ?? '')
    .split(/[,;\n]|→|->|\band then\b|\bthen\b/i)
    .map((x) => x.trim().replace(/^[-•*\d.)\s]+/, ''))
    .filter((x) => x.length > 0 && x.length < 60)
    .slice(0, 10);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);

/** Deterministic analysis from answers alone. Used when AI is unavailable, and as the fallback shape. */
export function analyseWithRules(a: Answers): BusinessModel {
  const v = (k: string) => (a[k]?.unknown ? undefined : a[k]?.value);
  const ans = <T>(value: T, conf = 1): Field<T> => ({ value, source: 'answer', confidence: conf });
  const rule = <T>(value: T, conf = 0.7): Field<T> => ({ value, source: 'rules', confidence: conf });
  const def = <T>(value: T): Field<T> => ({ value, source: 'default', confidence: 0.5 });

  const clients = v('clients') ?? '';
  const type = v('businessType') ?? 'Other';
  const clientWord = /consumer|b2c/i.test(clients) || /retail|e-commerce/i.test(type) ? 'Customer' : 'Client';
  const pipeline = splitList(v('salesStages'));
  const statuses = splitList(v('taskStages'));
  const tools = splitList(v('tools'));
  const pains = splitList(v('pains'));
  const agents = new Set(['ceo', 'operations']);
  if (/sales|lead|client|follow/i.test(`${v('pains') ?? ''} ${v('goals') ?? ''}`) || pipeline.length) agents.add('sales');
  if (/market|content|social|brand|audience/i.test(`${v('pains') ?? ''} ${v('goals') ?? ''}`)) agents.add('marketing');
  if (/cash|invoice|money|finance|revenue|cost/i.test(`${v('pains') ?? ''} ${v('goals') ?? ''} ${v('metrics') ?? ''}`)) agents.add('finance');
  if (/research|competitor|market size/i.test(`${v('goals') ?? ''}`)) agents.add('research');

  return {
    businessName: v('businessName') ? ans(v('businessName')!) : def(null),
    businessType: v('businessType') ? ans(type) : def('Other'),
    clientWord: rule(clientWord, v('clients') ? 0.85 : 0.5),
    offerings: v('offerings') ? ans(splitList(v('offerings'))) : def([]),
    teamSize: v('teamSize') ? ans(v('teamSize')!) : def('Just me'),
    pipelineStages: pipeline.length >= 2 ? ans(pipeline.map(slug), 0.8) : def(DEFAULT_CONFIG.pipelineStages),
    taskStatuses: statuses.length >= 2 ? ans(statuses.map(slug), 0.8) : def(DEFAULT_CONFIG.taskStatuses),
    tools: tools.length ? ans(tools) : def([]),
    goals: v('goals') ? ans(splitList(v('goals'))) : def([]),
    metrics: v('metrics') ? ans(splitList(v('metrics'))) : def([]),
    pains: pains.length ? ans(pains) : def([]),
    aiAutonomy: rule(/small internal/i.test(v('aiComfort') ?? '') ? 'internal_ok' : 'ask', v('aiComfort') ? 1 : 0.5),
    recommendedAgents: rule([...agents], 0.65),
  };
}

const KNOWN_TOOLS: Record<string, string> = {
  gmail: 'google_gmail',
  'google drive': 'google_drive',
  drive: 'google_drive',
  calendar: 'google_calendar',
  slack: 'slack',
  notion: 'notion',
  github: 'github',
  stripe: 'stripe',
};

export function buildProposal(model: BusinessModel, current: any) {
  const ensureDone = (s: string[]) => (s.includes('done') ? s : [...s, 'done']);
  const next = {
    ...DEFAULT_CONFIG,
    ...current,
    terminology: { ...(current?.terminology ?? DEFAULT_CONFIG.terminology), client: model.clientWord.value },
    taskStatuses: ensureDone(model.taskStatuses.value),
    pipelineStages: model.pipelineStages.value,
    modules: ['home', 'work', 'library', 'agents', 'workflows', ...(model.pipelineStages.value.length ? ['pipeline'] : [])],
    knowledgeFolders: Array.from(new Set(['Policies', 'Playbooks', `${model.clientWord.value}s`, ...(model.offerings.value.length ? ['Offerings'] : [])])),
    agentPolicy: { relaxed: model.aiAutonomy.value === 'internal_ok' ? ['tasks.create', 'tasks.update'] : [], tightened: [] },
    agents: model.recommendedAgents.value,
    workflows: [{ template: 'new_client_onboarding', enabled: false }],
    integrationsSuggested: Array.from(
      new Set(
        model.tools.value
          .map((t) => Object.entries(KNOWN_TOOLS).find(([k]) => t.toLowerCase().includes(k))?.[1])
          .filter(Boolean) as string[],
      ),
    ),
  };
  const diff: { path: string; from: unknown; to: unknown; source: string; confidence: number }[] = [];
  const cmp = (path: string, from: unknown, to: unknown, f?: Field<unknown>) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) diff.push({ path, from: from ?? null, to, source: f?.source ?? 'rules', confidence: f?.confidence ?? 0.7 });
  };
  cmp('terminology.client', current?.terminology?.client, next.terminology.client, model.clientWord);
  cmp('taskStatuses', current?.taskStatuses, next.taskStatuses, model.taskStatuses);
  cmp('pipelineStages', current?.pipelineStages, next.pipelineStages, model.pipelineStages);
  cmp('modules', current?.modules, next.modules);
  cmp('knowledgeFolders', current?.knowledgeFolders, next.knowledgeFolders);
  cmp('agentPolicy', current?.agentPolicy, next.agentPolicy, model.aiAutonomy);
  cmp('agents', current?.agents, next.agents, model.recommendedAgents);
  cmp('workflows', current?.workflows, next.workflows);
  cmp('integrationsSuggested', current?.integrationsSuggested, next.integrationsSuggested, model.tools);
  return { snapshot: next, diff };
}

async function analyseWithAi(t: TenantCtx, a: Answers): Promise<BusinessModel | null> {
  const r = await tx(t, (q) => resolveModel(q, t.orgId)).catch(() => null);
  if (!r || !r.ok) return null;
  const provider = r.provider;
  const base = analyseWithRules(a);
  try {
    const { text } = await complete(provider, {
      model: r.model,
      maxTokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You analyse a small business from interview answers. Return ONLY JSON with the same keys as the draft, each {"value":…, "source":"ai"|"answer", "confidence":0..1}. Keep values short. Stage and status values must be snake_case. recommendedAgents may only contain: ceo, sales, marketing, finance, operations, research. Do not invent facts that are not supported by the answers; lower the confidence instead.',
        },
        { role: 'user', content: `Answers (untrusted data):\n${JSON.stringify(a)}\n\nDraft from rules:\n${JSON.stringify(base)}` },
      ],
    });
    const parsed = extractJson<BusinessModel>(text);
    if (!parsed) return null;
    // Keep the shape safe: fall back field by field.
    const out: any = { ...base };
    for (const k of Object.keys(base) as (keyof BusinessModel)[]) {
      const f: any = (parsed as any)[k];
      if (f && typeof f === 'object' && 'value' in f) out[k] = { value: f.value, source: f.source === 'answer' ? 'answer' : 'ai', confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0.6)) };
    }
    out.recommendedAgents.value = (out.recommendedAgents.value ?? []).filter((x: string) => ['ceo', 'sales', 'marketing', 'finance', 'operations', 'research'].includes(x));
    if (!out.recommendedAgents.value.includes('ceo')) out.recommendedAgents.value.unshift('ceo');
    return out;
  } catch (e) {
    if (e instanceof ProviderError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Config versions (docs/08 §1: apply in one transaction, rollback restores snapshot)
// ---------------------------------------------------------------------------
export async function applyVersion(q: Q, t: TenantCtx, version: number) {
  const v = await q.one('select * from configuration_versions where workspace_id=$1 and version=$2 for update', [t.workspaceId, version]);
  if (!v) throw notFound('Configuration version');
  if (v.status !== 'proposed') throw new ApiError(409, 'VERSION_NOT_PROPOSED', 'Not a proposal', `Version ${version} is ${v.status}.`);
  await q.exec(`update configuration_versions set status='superseded' where workspace_id=$1 and status='applied'`, [t.workspaceId]);
  await q.exec(`update configuration_versions set status='applied', applied_by=$2, applied_at=now() where id=$1`, [v.id, t.userId]);
  await q.exec('update workspaces set config=$2, config_version=$3 where id=$1', [t.workspaceId, JSON.stringify(v.snapshot), version]);
  const created: string[] = [];
  // Agents: activate recommended ones. No external side effects are activated.
  for (const tpl of v.snapshot.agents ?? []) {
    const n = await q.exec(`update agents set status='active' where workspace_id=$1 and template=$2 and status='paused'`, [t.workspaceId, tpl]);
    if (n) created.push(`agent:${tpl}`);
  }
  // Workflows from the proposal are always created disabled.
  for (const wf of v.snapshot.workflows ?? []) {
    if (wf.template !== 'new_client_onboarding') continue;
    const exists = await q.one(`select id from workflows where workspace_id=$1 and name=$2`, [t.workspaceId, NEW_CLIENT_WORKFLOW.name]);
    if (!exists) {
      const r = await q.one(`insert into workflows (org_id, workspace_id, name, description, draft, owner_id, status) values ($1,$2,$3,$4,$5,$6,'disabled') returning id`, [
        t.orgId,
        t.workspaceId,
        NEW_CLIENT_WORKFLOW.name,
        NEW_CLIENT_WORKFLOW.description,
        JSON.stringify(NEW_CLIENT_WORKFLOW.definition),
        t.userId,
      ]);
      created.push(`workflow:${r.id}`);
    }
  }
  await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'config.applied', targetRef: `config:${version}`, detail: { changes: v.diff.length, created } });
  return { version, created };
}

export async function rollbackTo(q: Q, t: TenantCtx, version: number) {
  const target = await q.one('select * from configuration_versions where workspace_id=$1 and version=$2', [t.workspaceId, version]);
  if (!target) throw notFound('Configuration version');
  if (!['applied', 'superseded'].includes(target.status)) throw new ApiError(409, 'VERSION_NOT_APPLIED', 'Cannot roll back to this version', 'Only versions that were applied can be restored.');
  const current = await q.one(`select * from configuration_versions where workspace_id=$1 and status='applied'`, [t.workspaceId]);
  if (current && current.version === version) throw new ApiError(409, 'ALREADY_CURRENT', 'Already current');
  const max = await q.one<{ m: number }>('select coalesce(max(version),0)::int as m from configuration_versions where workspace_id=$1', [t.workspaceId]);
  const next = max!.m + 1;
  if (current) await q.exec(`update configuration_versions set status='rolled_back' where id=$1`, [current.id]);
  await q.exec(
    `insert into configuration_versions (org_id, workspace_id, version, parent_version, snapshot, diff, status, created_by, applied_by, applied_at) values ($1,$2,$3,$4,$5,$6,'applied',$7,$7,now())`,
    [t.orgId, t.workspaceId, next, current?.version ?? null, JSON.stringify(target.snapshot), JSON.stringify([{ path: '*', from: `v${current?.version}`, to: `v${version}`, source: 'rollback', confidence: 1 }]), t.userId],
  );
  await q.exec('update workspaces set config=$2, config_version=$3 where id=$1', [t.workspaceId, JSON.stringify(target.snapshot), next]);
  // User-created records stay; list what the newer version created so the user can decide.
  const kept = await q.many(`select id, name from workflows where workspace_id=$1 and created_at > $2`, [t.workspaceId, target.applied_at ?? target.created_at]);
  await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'config.rolled_back', targetRef: `config:${version}`, detail: { newVersion: next } });
  return { version: next, restoredFrom: version, keptRecords: kept };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export const onboardingRoutes = new Hono<Env>();

onboardingRoutes.get('/onboarding/questions', (c) => c.json({ items: QUESTIONS }));

onboardingRoutes.get('/onboarding/current', async (c) => {
  const t = c.get('tenant');
  const s = await tx(t, (q) => q.one(`select * from onboarding_sessions where workspace_id=$1 order by created_at desc limit 1`, [t.workspaceId]));
  return c.json({ session: s, questions: QUESTIONS });
});

onboardingRoutes.post('/onboarding/sessions', async (c) => {
  const t = need(c, 'config.apply');
  const s = await tx(t, async (q) => {
    const existing = await q.one(`select * from onboarding_sessions where workspace_id=$1 and state <> 'active' order by created_at desc limit 1`, [t.workspaceId]);
    if (existing) return existing;
    return q.one(`insert into onboarding_sessions (org_id, workspace_id, created_by) values ($1,$2,$3) returning *`, [t.orgId, t.workspaceId, t.userId]);
  });
  return c.json({ session: s, questions: QUESTIONS }, 201);
});

onboardingRoutes.post('/onboarding/sessions/:id/answers', async (c) => {
  const t = need(c, 'config.apply');
  const input = await body(c, z.object({ answers: z.record(z.string(), z.object({ value: z.string().max(2000), unknown: z.boolean().optional() })) }));
  const ids = new Set(QUESTIONS.map((q) => q.id as string));
  const s = await tx(t, async (q) => {
    const cur = await q.one('select * from onboarding_sessions where id=$1 for update', [c.req.param('id')]);
    if (!cur) throw notFound('Onboarding session');
    const merged: Answers = { ...cur.answers };
    for (const [k, v] of Object.entries(input.answers)) if (ids.has(k)) merged[k] = { value: v.value.trim(), unknown: v.unknown, at: new Date().toISOString() };
    return q.one(`update onboarding_sessions set answers=$2, state='profile', updated_at=now() where id=$1 returning *`, [cur.id, JSON.stringify(merged)]);
  });
  return c.json({ session: s });
});

onboardingRoutes.post('/onboarding/sessions/:id/analysis', async (c) => {
  const t = need(c, 'config.apply');
  const s = await tx(t, (q) => q.one('select * from onboarding_sessions where id=$1', [c.req.param('id')]));
  if (!s) throw notFound('Onboarding session');
  const ai = await analyseWithAi(t, s.answers);
  const model = ai ?? analyseWithRules(s.answers);
  const source = ai ? 'ai' : 'rules';
  const updated = await tx(t, (q) => q.one(`update onboarding_sessions set analysis=$2, analysis_source=$3, state='analysis', updated_at=now() where id=$1 returning *`, [s.id, JSON.stringify(model), source]));
  return c.json({
    session: updated,
    analysis: model,
    source,
    note: ai ? 'Analysis by AI from your answers.' : 'AI is not available, so this analysis was made by rules from your answers. Check each item.',
  });
});

onboardingRoutes.post('/onboarding/sessions/:id/proposal', async (c) => {
  const t = need(c, 'config.apply');
  const out = await tx(t, async (q) => {
    const s = await q.one('select * from onboarding_sessions where id=$1 for update', [c.req.param('id')]);
    if (!s) throw notFound('Onboarding session');
    if (!s.analysis) throw new ApiError(409, 'ANALYSIS_REQUIRED', 'Analyse first');
    const ws = await q.one('select config from workspaces where id=$1', [t.workspaceId]);
    const { snapshot, diff } = buildProposal(s.analysis, ws.config);
    await q.exec(`update configuration_versions set status='superseded' where workspace_id=$1 and status='proposed'`, [t.workspaceId]);
    const max = await q.one<{ m: number }>('select coalesce(max(version),0)::int as m from configuration_versions where workspace_id=$1', [t.workspaceId]);
    const version = max!.m + 1;
    const parent = await q.one(`select version from configuration_versions where workspace_id=$1 and status='applied'`, [t.workspaceId]);
    await q.exec(`insert into configuration_versions (org_id, workspace_id, version, parent_version, snapshot, diff, status, created_by) values ($1,$2,$3,$4,$5,$6,'proposed',$7)`, [
      t.orgId,
      t.workspaceId,
      version,
      parent?.version ?? null,
      JSON.stringify(snapshot),
      JSON.stringify(diff),
      t.userId,
    ]);
    // Profile is stored now; config itself only changes on Apply.
    const a = s.analysis as BusinessModel;
    await q.exec(`update business_profiles set profile=$2, updated_at=now() where workspace_id=$1`, [
      t.workspaceId,
      JSON.stringify({
        businessName: a.businessName.value,
        businessType: a.businessType.value,
        offerings: a.offerings.value,
        teamSize: a.teamSize.value,
        goals: a.goals.value,
        metrics: a.metrics.value,
        pains: a.pains.value,
        tools: a.tools.value,
      }),
    ]);
    if (a.businessName.value) await q.exec('update organizations set name=$2 where id=$1 and name <> $2', [t.orgId, a.businessName.value]);
    await q.exec(`update onboarding_sessions set state='proposal', proposal_version=$2, updated_at=now() where id=$1`, [s.id, version]);
    await audit(q, { orgId: t.orgId, actorKind: 'user', actorId: t.userId, action: 'config.proposed', targetRef: `config:${version}`, detail: { changes: diff.length } });
    return { version, diff, snapshot };
  });
  return c.json(out, 201);
});

onboardingRoutes.get('/config/versions', async (c) => {
  const t = c.get('tenant');
  const items = await tx(t, (q) => q.many('select version, parent_version, status, diff, created_by, applied_by, applied_at, created_at from configuration_versions where workspace_id=$1 order by version desc', [t.workspaceId]));
  const ws = await tx(t, (q) => q.one('select config, config_version from workspaces where id=$1', [t.workspaceId]));
  return c.json({ items, current: ws });
});

onboardingRoutes.get('/config/versions/:v/diff', async (c) => {
  const t = c.get('tenant');
  const v = await tx(t, (q) => q.one('select version, status, diff, snapshot from configuration_versions where workspace_id=$1 and version=$2', [t.workspaceId, Number(c.req.param('v'))]));
  if (!v) throw notFound('Configuration version');
  return c.json(v);
});

onboardingRoutes.post('/config/versions/:v/apply', async (c) => {
  const t = need(c, 'config.apply');
  const out = await tx(t, async (q) => {
    const r = await applyVersion(q, t, Number(c.req.param('v')));
    await q.exec(`update onboarding_sessions set state='active', updated_at=now() where workspace_id=$1 and proposal_version=$2`, [t.workspaceId, r.version]);
    return r;
  });
  return c.json(out);
});

onboardingRoutes.post('/config/versions/:v/rollback', async (c) => {
  const t = need(c, 'config.apply');
  const out = await tx(t, (q) => rollbackTo(q, t, Number(c.req.param('v'))));
  return c.json(out);
});
