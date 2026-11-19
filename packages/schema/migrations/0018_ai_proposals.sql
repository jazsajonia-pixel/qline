-- Personal AI OS phase 6 (docs/21, M8): typed AI proposals. The model can only *propose* a mission or a change to an
-- agent; a person reviews, edits, approves or rejects it in the app, and applying always runs through the same
-- permission-checked code as the human routes. Additive.
-- Recovery: drop table ai_proposals;
create table if not exists ai_proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('mission','agent_change')),
  title text not null check (length(title) between 1 and 200),
  payload jsonb not null,
  -- proposed (by the AI) → edited (by a person) → applied | rejected | failed
  status text not null default 'proposed' check (status in ('proposed','edited','applied','rejected','failed')),
  target_ref text,
  applied_ref text,
  error text,
  proposed_by text not null,
  proposed_for text,
  revision int not null default 1,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_proposals_ws on ai_proposals (org_id, workspace_id, status, created_at desc);
alter table ai_proposals enable row level security;
drop policy if exists tenant_isolation on ai_proposals;
create policy tenant_isolation on ai_proposals using (org_id = qline_org()) with check (org_id = qline_org());

-- missions.propose joins every built-in agent; agents.propose_change joins the CEO (same pattern as 0012).
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['missions.propose']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template <> 'custom';
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['agents.propose_change']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template = 'ceo';
