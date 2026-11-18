import { z } from 'zod';
import { MISSION_AGENTS, validatePlan } from '@qline/policy';
import { audit } from '../core/audit';
import { slackChannelName, slackChannels, slackCreateChannel, slackSetTopic } from '../integrations/services';
import { kick } from '../runtime/jobs';
import { connection, fail } from './tools-apps';
import type { ToolDef } from './tools';

/**
 * v1.6 tools: edit more business data, manage Slack channels, and let the CEO hand work to
 * specialist agents that run in the background (as one-task missions on the durable runtime).
 */
const slackManage = () => 'channels:manage';

export const v16Tools = {
  'companies.update': {
    description: 'Update a company in the CRM: name, website domain or notes.',
    schema: z.object({ companyId: z.string().uuid(), name: z.string().trim().min(1).max(200).optional(), domain: z.string().trim().max(200).optional(), notes: z.string().max(4000).optional() }),
    async execute(q, ctx, a) {
      const domain = a.domain ? a.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase() : null;
      const r = await q.one(
        `update companies set name=coalesce($2,name), domain=coalesce($3,domain), notes=coalesce($4,notes), updated_at=now() where id=$1 and deleted_at is null returning id, name`,
        [a.companyId, a.name ?? null, domain, a.notes ?? null],
      );
      if (!r) return fail('Company not found');
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'company.updated', targetRef: `company:${r.id}`, detail: { fields: Object.keys(a).filter((k) => k !== 'companyId') } });
      return { ok: true, summary: `Updated ${r.name}`, refs: [{ type: 'company', id: r.id, title: r.name }] };
    },
    preview: (a) => ({ title: 'Update company', lines: Object.entries(a).filter(([k]) => k !== 'companyId').map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`) }),
  } satisfies ToolDef<any>,

  'projects.update': {
    description: 'Rename a project, change its description, or set its status (active, on_hold, done, archived).',
    schema: z.object({ projectId: z.string().uuid(), name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), status: z.enum(['active', 'on_hold', 'done', 'archived']).optional() }),
    async execute(q, ctx, a) {
      const r = await q.one(
        `update projects set name=coalesce($2,name), description=coalesce($3,description), status=coalesce($4,status), updated_at=now() where id=$1 returning id, name, status`,
        [a.projectId, a.name ?? null, a.description ?? null, a.status ?? null],
      );
      if (!r) return fail('Project not found');
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'project.updated', targetRef: `project:${r.id}`, detail: { status: a.status } });
      return { ok: true, summary: `Updated project “${r.name}” (${r.status})`, refs: [{ type: 'project', id: r.id, title: r.name }] };
    },
    preview: (a) => ({ title: 'Update project', lines: Object.entries(a).filter(([k]) => k !== 'projectId').map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`) }),
  } satisfies ToolDef<any>,

  'slack.channel.create': {
    description: 'Create a public Slack channel (or reuse one with that name), optionally with a topic and purpose, and optionally make it the channel Qline posts alerts to.',
    schema: z.object({
      name: z.string().trim().min(1).max(80).describe('Channel name, e.g. "sales-leads"'),
      topic: z.string().max(250).optional(),
      purpose: z.string().max(250).optional(),
      makeDefault: z.boolean().optional().describe('Use this channel for Qline alerts and posts'),
    }),
    async execute(q, ctx, a) {
      const c = await connection(q, ['slack'], slackManage);
      if (typeof c === 'string') return fail(c.includes('permission') ? 'Slack is connected without channel management. Reconnect Slack in Settings → Integrations to allow it.' : c);
      const name = slackChannelName(a.name);
      if (!name) return fail('That is not a valid Slack channel name.');
      const existing = (await slackChannels(c.token)).find((x) => x.name === name);
      const ch = existing ?? (await slackCreateChannel(c.token, name));
      await slackSetTopic(c.token, ch.id, a.topic, a.purpose);
      if (a.makeDefault) await q.exec(`update integration_connections set settings = settings || $2::jsonb, updated_at=now() where id=$1`, [c.conn.id, JSON.stringify({ channel: { id: ch.id, name: ch.name } })]);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: existing ? 'slack.channel.reused' : 'slack.channel.created', targetRef: `slack:${ch.id}`, detail: { name: ch.name } });
      return { ok: true, summary: `${existing ? 'Using existing' : 'Created'} #${ch.name}${a.makeDefault ? ' (now the Qline channel)' : ''}`, refs: [], data: ch };
    },
    preview: (a) => ({ title: `Create Slack channel #${slackChannelName(a.name)}`, lines: ['Public channel', a.topic, a.makeDefault ? 'Becomes the Qline alerts channel' : undefined].filter(Boolean) as string[] }),
  } satisfies ToolDef<any>,

  'slack.channel.topic': {
    description: "Set a Slack channel's topic and/or purpose.",
    schema: z.object({ channel: z.string().trim().min(1).max(80), topic: z.string().max(250).optional(), purpose: z.string().max(250).optional() }),
    async execute(q, ctx, a) {
      if (!a.topic && !a.purpose) return fail('Give a topic or a purpose.');
      const c = await connection(q, ['slack'], slackManage);
      if (typeof c === 'string') return fail(c.includes('permission') ? 'Slack is connected without channel management. Reconnect Slack in Settings → Integrations to allow it.' : c);
      const want = slackChannelName(a.channel);
      const ch = (await slackChannels(c.token)).find((x) => x.name === want || x.id === a.channel);
      if (!ch) return fail(`No public Slack channel named #${want}.`);
      await slackSetTopic(c.token, ch.id, a.topic, a.purpose);
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'slack.channel.topic', targetRef: `slack:${ch.id}` });
      return { ok: true, summary: `Updated #${ch.name}`, refs: [] };
    },
    preview: (a) => ({ title: `Update Slack #${slackChannelName(a.channel)}`, lines: [a.topic && `Topic: ${a.topic}`, a.purpose && `Purpose: ${a.purpose}`].filter(Boolean) as string[] }),
  } satisfies ToolDef<any>,

  'agents.delegate': {
    description:
      'Hand a piece of work to a specialist agent (sales, marketing, finance, operations, research). It runs in the background as a mission; you get a mission id to check with agents.status. Use when work takes several steps or belongs to another specialist.',
    schema: z.object({
      agent: z.enum(MISSION_AGENTS),
      title: z.string().trim().min(3).max(200),
      instructions: z.string().trim().min(3).max(4000).describe('What to do, with any context the agent needs'),
    }),
    async execute(q, ctx, a) {
      const ws = await q.one(`select config from workspaces where id=$1`, [ctx.workspaceId]);
      const autonomy = ws?.config?.agentPolicy?.autonomy ?? 'supervised';
      const agent = await q.one(`select name, status from agents where workspace_id=$1 and template=$2`, [ctx.workspaceId, a.agent]);
      if (!agent) return fail(`There is no ${a.agent} agent in this workspace.`);
      if (agent.status !== 'active') return fail(`${agent.name} is paused. Ask the owner to activate it in Agents.`);
      const plan = {
        summary: a.title,
        tasks: [{ key: 'work', agent: a.agent, title: a.title, instructions: a.instructions, dependsOn: [], inputs: {}, outputSchema: { type: 'object', properties: { summary: { type: 'string', maxLength: 4000 } }, required: ['summary'] }, review: 'schema' }],
      };
      const v = validatePlan(plan);
      if (!v.ok) return fail(v.errors.join('; '));
      const { startPlan, trace } = await import('../modules/missions');
      const { getControls } = await import('../core/controls');
      if ((await getControls(q, ctx.workspaceId)).emergency_stop) return fail('Emergency stop is on.');
      const m = await q.one(
        `insert into missions (org_id, workspace_id, goal, created_by, budget_tokens, budget_tool_calls, budget_wall_seconds, max_parallel, status)
         values ($1,$2,$3,$4,60000,20,1800,1,'planning') returning id`,
        [ctx.orgId, ctx.workspaceId, `${a.title}\n\n${a.instructions}`.slice(0, 4000), ctx.userId],
      );
      const p = await q.one(`insert into mission_plans (org_id, mission_id, version, plan, status) values ($1,$2,1,$3,'proposed') returning id, plan`, [ctx.orgId, m.id, JSON.stringify(v.plan)]);
      await q.exec(`update missions set status='awaiting_plan_approval', current_plan_id=$2, updated_at=now() where id=$1`, [m.id, p.id]);
      await trace(q, ctx.orgId, m.id, 'mission.delegated', `${ctx.actor.kind}:${ctx.actor.id}`, { agent: a.agent, title: a.title });
      await audit(q, { orgId: ctx.orgId, actorKind: ctx.actor.kind, actorId: ctx.actor.id, action: 'mission.delegated', targetRef: `mission:${m.id}`, detail: { agent: a.agent } });
      // Supervised workspaces review the hand-off in Missions; autopilot starts it straight away.
      if (autonomy === 'supervised') {
        return { ok: true, summary: `Asked ${agent.name} to “${a.title}”. It is waiting for your OK in Missions.`, refs: [{ type: 'mission', id: m.id, title: a.title }], data: { missionId: m.id, status: 'awaiting_plan_approval' } };
      }
      await q.exec(`update mission_plans set status='approved', decided_by=$2, decided_at=now(), decision_note='Auto-approved by autopilot' where id=$1`, [p.id, `autopilot:${ctx.userId}`]);
      const started = await startPlan(q, ctx.orgId, { id: m.id, workspace_id: ctx.workspaceId }, p, `autopilot:${ctx.userId}`);
      if (started) kick();
      return { ok: true, summary: `${agent.name} is working on “${a.title}” in the background.`, refs: [{ type: 'mission', id: m.id, title: a.title }], data: { missionId: m.id, status: 'running' } };
    },
    preview: (a) => ({ title: `Hand to ${a.agent}: ${a.title}`, lines: [a.instructions.slice(0, 300)] }),
  } satisfies ToolDef<any>,

  'agents.status': {
    description: 'Check on background work handed to agents (missions): status, progress and results. Give a missionId, or omit it for the latest ones.',
    schema: z.object({ missionId: z.string().uuid().optional(), limit: z.number().int().min(1).max(10).optional() }),
    async execute(q, _ctx, a) {
      const rows = await q.many(
        `select m.id, left(m.goal, 200) as goal, m.status, m.result, m.error, m.updated_at,
           (select json_agg(json_build_object('agent', t.agent, 'title', t.title, 'status', t.status, 'output', t.output, 'error', t.error) order by t.created_at)
              from mission_tasks t where t.mission_id=m.id and t.plan_id=m.current_plan_id) as tasks
         from missions m where ($1::uuid is null or m.id=$1) order by m.created_at desc limit $2`,
        [a.missionId ?? null, a.missionId ? 1 : (a.limit ?? 5)],
      );
      if (!rows.length) return fail(a.missionId ? 'Mission not found' : 'No background work yet.');
      return { ok: true, summary: rows.map((r) => `${r.goal.split('\n')[0]}: ${r.status}`).join('; ').slice(0, 300), refs: rows.map((r) => ({ type: 'mission', id: r.id, title: r.goal.split('\n')[0] })), data: rows };
    },
    preview: () => ({ title: 'Check background work', lines: [] }),
  } satisfies ToolDef<any>,
};
