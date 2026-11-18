-- M1 action safety (docs/17).
-- 1. Full-autopilot external actions reserve a slot in a per-workspace ledger before they run, under a per-workspace
--    advisory lock, so concurrent workers can never pass the daily cap together.
-- 2. tool_calls can be resolved by a person after an "unknown" outcome (the provider may or may not have done it).
--
-- Additive only: no existing column, constraint or row is changed or removed.
-- Recovery / down migration (if ever needed):
--   drop table if exists external_action_reservations;
--   alter table tool_calls drop column if exists resolution, drop column if exists resolved_by,
--     drop column if exists resolved_at, drop column if exists resolution_note;
--   drop function if exists qline_mark_stale_executing(int, text[]);
--   (the previous code ignores both, so rolling the API back without the down migration is also safe)

create table if not exists external_action_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null,
  tool_call_id uuid not null,
  tool text not null,
  -- reserved: slot held, action running · consumed: it happened or may have happened · released: it definitely did not
  status text not null default 'reserved' check (status in ('reserved','consumed','released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (org_id, tool_call_id),
  foreign key (org_id, tool_call_id) references tool_calls(org_id, id) on delete cascade
);
create index if not exists external_action_reservations_window
  on external_action_reservations (workspace_id, created_at) where status <> 'released';

alter table external_action_reservations enable row level security;
drop policy if exists tenant_isolation on external_action_reservations;
create policy tenant_isolation on external_action_reservations using (org_id = qline_org()) with check (org_id = qline_org());

-- Backfill the last 24 hours so the cap is not reset by this deploy (previously counted from tool_calls, not per workspace).
insert into external_action_reservations (org_id, workspace_id, tool_call_id, tool, status, created_at, settled_at)
select tc.org_id, coalesce(a.workspace_id, m.workspace_id), tc.id, tc.tool, 'consumed', tc.created_at, coalesce(tc.finished_at, now())
  from tool_calls tc
  left join agent_runs r on r.id = tc.run_id
  left join agents a on a.id = r.agent_id
  left join mission_tasks mt on mt.id = tc.mission_task_id
  left join missions m on m.id = mt.mission_id
 where tc.risk = 'L3' and tc.policy_decision = 'allow' and tc.status in ('executing','succeeded','unknown')
   and tc.created_at > now() - interval '24 hours'
   and coalesce(a.workspace_id, m.workspace_id) is not null
on conflict do nothing;

alter table tool_calls add column if not exists resolution text check (resolution in ('done','not_done'));
alter table tool_calls add column if not exists resolution_note text;
alter table tool_calls add column if not exists resolved_by text;
alter table tool_calls add column if not exists resolved_at timestamptz;
create index if not exists tool_calls_unknown on tool_calls (org_id, created_at) where status = 'unknown' and resolution is null;
create index if not exists tool_calls_executing on tool_calls (created_at) where status = 'executing';

-- Reconciler (scheduler tick, all tenants): an action still "executing" long after any provider timeout was interrupted
-- (crash, lost lease, DB failure after the provider call).
-- * Actions in connected apps (p_external) may or may not have happened: they become "unknown", their cap slot stays
--   used, and a person resolves them. Never re-executed.
-- * Qline-only actions run in the same transaction as their status update, so an interrupted one rolled back and
--   definitely did not happen: they become "failed".
drop function if exists qline_mark_stale_executing(int);
create or replace function qline_mark_stale_executing(p_minutes int, p_external text[])
returns table (org_id uuid, tool_call_id uuid, tool text, outcome text)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with stale as (
    update tool_calls tc
       set status = case when tc.tool = any(p_external) or tc.risk = 'L3' then 'unknown' else 'failed' end,
           finished_at = now(),
           result_summary = case when tc.tool = any(p_external) or tc.risk = 'L3'
             then 'Outcome unknown: the attempt was interrupted, so the connected app may or may not have done this. Not retried.'
             else 'Interrupted before finishing; nothing was saved.' end
     where tc.status = 'executing' and tc.created_at < now() - make_interval(mins => greatest(p_minutes, 5))
     returning tc.org_id, tc.id, tc.tool, tc.status
  ), settle as (
    update external_action_reservations r
       set status = case when s.status = 'failed' then 'released' else 'consumed' end, settled_at = now()
      from stale s where r.tool_call_id = s.id and r.status = 'reserved'
  )
  select s.org_id, s.id, s.tool, s.status from stale s;
end $$;
