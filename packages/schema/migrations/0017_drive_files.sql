-- Personal AI OS phase 5 (docs/21): files brought into a chat from Google Drive are stored as Qline copies with
-- source 'drive', so they open and download through the same permission-checked /files routes as attachments.
-- The Drive file itself is never shared or changed. Additive.
-- Recovery: delete from files where source='drive' (after removing their storage objects), then restore the check:
--   alter table files drop constraint files_source_check;
--   alter table files add constraint files_source_check check (source in ('import','chat'));
alter table files drop constraint if exists files_source_check;
alter table files add constraint files_source_check check (source in ('import','chat','drive'));

-- drive.fetch joins each built-in agent's current version (same pattern as 0012). Custom agents keep their own lists.
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['drive.fetch']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template <> 'custom' and 'drive.search' = any(v.tool_allowlist);
