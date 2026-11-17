-- v1.5 assistant tools: add them to each agent's current version, matching the template defaults in @qline/policy.
-- Same approach as 0006. Approval rules are unchanged: tools are allowed or approval-gated by policy, not by this list.
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array[
     'time.now','documents.read','contacts.get','projects.list','business.snapshot','sheets.read']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version;

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['tasks.comment','sheets.append']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template <> 'research';

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['slack.channels','companies.create']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','sales','marketing','operations');

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['projects.create']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','operations');
