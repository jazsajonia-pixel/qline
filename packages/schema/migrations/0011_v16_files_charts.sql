-- v1.6 run 2: files sent to the AI in chat, and charts/images in replies.
-- files.source tells chat attachments from imports; files.extracted keeps the parsed text or rows
-- (bounded) so the AI can read them without re-parsing, and images are flagged for display.
alter table files add column if not exists source text not null default 'import';
alter table files add column if not exists extracted jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'files_source_check') then
    alter table files add constraint files_source_check check (source in ('import','chat'));
  end if;
end $$;
create index if not exists files_ws_source on files (workspace_id, source, created_at desc);

-- New tools on each agent's current version (same pattern as 0009/0010).
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['files.read','files.save_to_library','chart.business','chart.create','image.show']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version;

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['files.import_records']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','sales','marketing','operations');
