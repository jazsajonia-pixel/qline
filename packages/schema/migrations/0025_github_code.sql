-- v1.10 GitHub expansion (docs/24): code browsing, branches, commits, pull requests and CI.
-- No schema change. Built-in agents keep their tool lists on their current version, so the new tools are added
-- there (same pattern as 0012 and 0017). Custom agents keep their own lists: an owner adds tools to them.
--   Reads: every built-in agent that already has GitHub reads.
--   Writes (always approved, L3): built-in CEO and Operations agents, the same ones that can open GitHub issues.
-- Recovery: remove the names again with array_remove on the current versions (they are only tool names).
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array[
     'github.repo','github.tree','github.file','github.code_search','github.branches','github.commits','github.commit',
     'github.compare','github.pulls','github.pull','github.runs','github.run','github.checks'
   ]) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template <> 'custom' and 'github.repos' = any(v.tool_allowlist);

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array[
     'github.branch.create','github.files.commit','github.pr.create','github.pr.update','github.pr.review'
   ]) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','operations') and 'github.issue.create' = any(v.tool_allowlist);
