-- M2 chat continuity and context reuse (docs/18).
-- 1. data_changes: an append-only log of which tables changed, per org, written by statement-level triggers. Each row
--    carries the writing transaction id, so a cached read can be checked exactly against the snapshot it was taken
--    under (pg_visible_in_snapshot). This catches every write path: the app, agents, imports, syncs and workflows.
-- 2. conversation_context: a conversation-scoped ledger of read-only tool results the AI may reuse while still fresh.
--    Short-lived (≤ 30 min TTL, purged by the scheduler tick), scoped to org + workspace + conversation + user + role.
-- 3. tool_calls.reused_context_id marks a tool call answered from the ledger.
--
-- Additive only. Recovery / down migration (if ever needed):
--   do $$ declare t text; begin foreach t in array array['tasks','task_comments','projects','companies','contacts',
--     'documents','memory_records','knowledge_links','knowledge_categories','workflows','workflow_versions','files',
--     'lead_inbox','integration_connections'] loop
--     execute format('drop trigger if exists qline_changes_ins on %I; drop trigger if exists qline_changes_upd on %I;
--                     drop trigger if exists qline_changes_del on %I', t, t, t); end loop; end $$;
--   drop function if exists qline_note_change(); drop function if exists qline_purge_context();
--   drop table if exists conversation_context; drop table if exists data_changes;
--   alter table tool_calls drop column if exists reused_context_id;
--   delete from schema_migrations where name = '0014_m2_context_ledger.sql';
--   (the v1.6 / M1 API ignores all of these, so rolling the API back without the down migration is also safe)

create table if not exists data_changes (
  id bigserial primary key,
  org_id uuid not null,
  tbl text not null,
  xid xid8 not null default pg_current_xact_id(),
  changed_at timestamptz not null default clock_timestamp()
);
create index if not exists data_changes_lookup on data_changes (org_id, tbl, changed_at);
create index if not exists data_changes_age on data_changes (changed_at);
alter table data_changes enable row level security;
drop policy if exists tenant_isolation on data_changes;
create policy tenant_isolation on data_changes using (org_id = qline_org()) with check (org_id = qline_org());

-- Owner-defined so it can always log, whatever tenant context (or none) the writer runs under. It only inserts.
create or replace function qline_note_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    insert into data_changes (org_id, tbl) select distinct o.org_id, tg_table_name from old_rows o where o.org_id is not null;
  else
    insert into data_changes (org_id, tbl) select distinct n.org_id, tg_table_name from new_rows n where n.org_id is not null;
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['tasks','task_comments','projects','companies','contacts','documents','memory_records',
    'knowledge_links','knowledge_categories','workflows','workflow_versions','files','lead_inbox','integration_connections'] loop
    execute format('drop trigger if exists qline_changes_ins on %I', t);
    execute format('drop trigger if exists qline_changes_upd on %I', t);
    execute format('drop trigger if exists qline_changes_del on %I', t);
    execute format('create trigger qline_changes_ins after insert on %I referencing new table as new_rows for each statement execute function qline_note_change()', t);
    execute format('create trigger qline_changes_upd after update on %I referencing new table as new_rows for each statement execute function qline_note_change()', t);
    execute format('create trigger qline_changes_del after delete on %I referencing old table as old_rows for each statement execute function qline_note_change()', t);
  end loop;
end $$;

create table if not exists conversation_context (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  conversation_id uuid not null,
  user_id text not null,
  role text not null,
  tool text not null,
  args_hash text not null,
  args jsonb not null,
  summary text not null,
  data jsonb,
  refs jsonb not null default '[]'::jsonb,
  source_tool_call_id uuid,
  -- the snapshot the result was read under: any change not visible in it makes the entry stale
  snap pg_snapshot not null,
  -- the read's own transaction (it may touch e.g. last_used_at); its own changes do not invalidate it
  own_xid xid8,
  duration_ms int not null default 0,
  provider_reads int not null default 0,
  result_chars int not null default 0,
  hits int not null default 0,
  last_hit_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  invalidated_at timestamptz,
  unique (org_id, conversation_id, user_id, tool, args_hash),
  foreign key (org_id, conversation_id) references conversations(org_id, id) on delete cascade
);
create index if not exists conversation_context_live on conversation_context (conversation_id, expires_at) where invalidated_at is null;
alter table conversation_context enable row level security;
drop policy if exists tenant_isolation on conversation_context;
create policy tenant_isolation on conversation_context using (org_id = qline_org()) with check (org_id = qline_org());

alter table tool_calls add column if not exists reused_context_id uuid;

-- Scheduler tick (all tenants): drop expired ledger entries and old change-log rows.
create or replace function qline_purge_context() returns int
language plpgsql volatile security definer set search_path = public as $$
declare n int; m int;
begin
  delete from conversation_context where expires_at < now() - interval '10 minutes' or invalidated_at < now() - interval '10 minutes';
  get diagnostics n = row_count;
  delete from data_changes where changed_at < now() - interval '2 hours';
  get diagnostics m = row_count;
  return n + m;
end $$;
