-- v1.5 AI CEO missions (docs/13 §6). A mission is a goal; the CEO proposes a plan; a human approves it;
-- tasks run under the durable runtime (docs/12) with slot limits, budgets, pause and emergency stop.
-- Every table carries org_id with RLS. The app role cannot DELETE mission rows (see 9999_app_role.sql).

create table if not exists workspace_controls (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  org_id uuid not null references organizations(id) on delete cascade,
  paused boolean not null default false,
  emergency_stop boolean not null default false,
  max_parallel_tasks int not null default 3 check (max_parallel_tasks between 1 and 4),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists missions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  goal text not null check (length(goal) between 3 and 4000),
  status text not null default 'planning' check (status in
    ('planning','awaiting_plan_approval','running','paused','needs_attention','completed','failed','cancelled','rejected')),
  created_by text not null,
  budget_tokens int not null default 200000 check (budget_tokens between 1000 and 2000000),
  budget_tool_calls int not null default 60 check (budget_tool_calls between 1 and 500),
  budget_wall_seconds int not null default 3600 check (budget_wall_seconds between 60 and 86400),
  spent_tokens int not null default 0,
  spent_tool_calls int not null default 0,
  max_parallel int not null default 2 check (max_parallel between 1 and 4),
  current_plan_id uuid,
  result jsonb,
  result_review text not null default 'pending' check (result_review in ('pending','accepted','rejected')),
  error text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create index if not exists missions_ws on missions (org_id, workspace_id, created_at desc);

create table if not exists mission_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mission_id uuid not null references missions(id) on delete cascade,
  version int not null,
  plan jsonb not null,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','superseded')),
  validation_errors jsonb not null default '[]'::jsonb,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  unique (mission_id, version)
);

create table if not exists mission_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  mission_id uuid not null references missions(id) on delete cascade,
  plan_id uuid not null references mission_plans(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  agent text not null check (agent in ('sales','marketing','finance','operations','research')),
  title text not null,
  instructions text not null,
  depends_on text[] not null default '{}',
  inputs jsonb not null default '{}'::jsonb,
  resolved_inputs jsonb,
  output_schema jsonb not null,
  review text not null default 'schema' check (review in ('schema','human')),
  tools text[] not null default '{}',
  depth int not null default 1 check (depth between 1 and 3),
  status text not null default 'blocked' check (status in
    ('blocked','ready','queued','running','review','succeeded','failed','skipped','cancelled','needs_attention')),
  output jsonb,
  evidence jsonb not null default '[]'::jsonb,
  error text,
  job_id uuid,
  attempts int not null default 0,
  tokens int not null default 0,
  tool_calls int not null default 0,
  reviewed_by text,
  review_note text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mission_id, key)
);
create index if not exists mission_tasks_mission on mission_tasks (mission_id, status);

create table if not exists mission_trace (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  mission_id uuid not null references missions(id) on delete cascade,
  task_id uuid references mission_tasks(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,60}$'),
  actor text not null,
  data jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists mission_trace_mission on mission_trace (mission_id, id);

-- Mission task tool calls reuse tool_calls (idempotent per key), linked to the task.
alter table tool_calls add column if not exists mission_task_id uuid references mission_tasks(id) on delete cascade;

do $$
declare t text;
begin
  foreach t in array array['workspace_controls','missions','mission_plans','mission_tasks','mission_trace'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (org_id = qline_org()) with check (org_id = qline_org())', t);
  end loop;
end $$;

-- Tenant-scoped grants for an existing app role (fresh databases get them from 9999_app_role.sql).
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'qline_app') then
    grant select, insert, update on workspace_controls, missions, mission_plans, mission_tasks, mission_trace to qline_app;
    grant usage, select on sequence mission_trace_id_seq to qline_app;
  end if;
end $$;
