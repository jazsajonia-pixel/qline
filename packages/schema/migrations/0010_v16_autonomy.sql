-- v1.6: reply metadata (spoken line + follow-up suggestions) and the new tools on each agent's current version.
-- Autonomy lives in workspaces.config.agentPolicy (autonomy, dailyExternalLimit); no schema change needed for it.
alter table conversation_messages add column if not exists meta jsonb not null default '{}'::jsonb;

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['companies.update']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','sales','marketing','operations');

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['projects.update','slack.channel.create','slack.channel.topic']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','operations');

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['agents.delegate','agents.status']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template = 'ceo';
