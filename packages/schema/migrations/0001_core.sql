-- Qline core schema (docs/05). Runs as the owner role. The API connects as
-- qline_app (no BYPASSRLS, not the table owner), so RLS below is enforced.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Better Auth tables (identity only; tenancy lives in our own tables)
-- ---------------------------------------------------------------------------
create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null default false,
  image text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create table if not exists "session" (
  id text primary key,
  "expiresAt" timestamptz not null,
  token text not null unique,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user"(id) on delete cascade
);
create index if not exists session_user_idx on "session"("userId");
create table if not exists "account" (
  id text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user"(id) on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists account_user_idx on "account"("userId");
create table if not exists "verification" (
  id text primary key,
  identifier text not null,
  value text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table if not exists organizations (
  id uuid primary key,
  name text not null check (length(name) between 1 and 120),
  status text not null default 'active' check (status in ('active','archived')),
  settings jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists organization_members (
  org_id uuid not null references organizations(id) on delete cascade,
  user_id text not null references "user"(id) on delete cascade,
  role text not null check (role in ('owner','admin','manager','member','viewer')),
  status text not null default 'active' check (status in ('active','suspended')),
  joined_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on organization_members(user_id);

create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  code_hash text not null unique,
  email text,
  role text not null check (role in ('admin','manager','member','viewer')),
  invited_by text not null,
  status text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null,
  accepted_by text,
  created_at timestamptz not null default now()
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  config_version int not null default 0,
  created_at timestamptz not null default now(),
  unique (org_id, id)
);

create table if not exists business_profiles (
  org_id uuid not null,
  workspace_id uuid not null,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (org_id, workspace_id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

create table if not exists configuration_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  version int not null,
  parent_version int,
  snapshot jsonb not null,
  diff jsonb not null,
  status text not null check (status in ('proposed','applied','rolled_back','superseded')),
  created_by text not null,
  applied_by text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, workspace_id, version),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------
create table if not exists onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  state text not null default 'profile' check (state in ('profile','data','analysis','proposal','active')),
  answers jsonb not null default '{}'::jsonb,
  analysis jsonb,
  analysis_source text,
  proposal_version int,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active','on_hold','done','archived')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  project_id uuid,
  title text not null check (length(title) between 1 and 300),
  description text,
  status text not null default 'todo',
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_at timestamptz,
  assignee_id text,
  source_kind text not null default 'user' check (source_kind in ('user','import','connector','agent_inferred','workflow')),
  source_ref text,
  import_job_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade,
  foreign key (org_id, project_id) references projects(org_id, id) on delete set null (project_id)
);
create index if not exists tasks_org_status_due on tasks(org_id, workspace_id, status, due_at) where deleted_at is null;

create table if not exists task_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  task_id uuid not null,
  body text not null,
  author_kind text not null default 'user',
  author_id text not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, task_id) references tasks(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- CRM (imported)
-- ---------------------------------------------------------------------------
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  name text not null,
  domain text,
  notes text,
  source_kind text not null default 'user',
  source_ref text,
  import_job_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  company_id uuid,
  name text not null,
  email text,
  phone text,
  title text,
  stage text,
  notes text,
  source_kind text not null default 'user',
  source_ref text,
  import_job_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade,
  foreign key (org_id, company_id) references companies(org_id, id) on delete set null (company_id)
);
create index if not exists contacts_org_email on contacts(org_id, lower(email)) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Files, documents, memory
-- ---------------------------------------------------------------------------
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  name text not null,
  mime text not null,
  size_bytes int not null,
  sha256 text not null,
  storage_key text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  file_id uuid,
  kind text not null default 'document' check (kind in ('document','note','draft_email')),
  title text not null,
  body text not null default '',
  folder text,
  source_kind text not null default 'user',
  source_ref text,
  import_job_id uuid,
  version int not null default 1,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  search tsvector generated always as (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,''))) stored,
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade,
  foreign key (org_id, file_id) references files(org_id, id) on delete set null (file_id)
);
create index if not exists documents_search on documents using gin(search);

create table if not exists memory_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  scope text not null default 'workspace',
  kind text not null default 'fact' check (kind in ('fact','preference','policy','context')),
  content text not null,
  source_kind text not null check (source_kind in ('user','import','connector','agent_inferred')),
  source_ref text,
  confidence numeric(3,2) not null default 1.00,
  status text not null default 'active' check (status in ('proposed','active','outdated','superseded','archived')),
  superseded_by uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Imports
-- ---------------------------------------------------------------------------
create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  file_id uuid not null,
  format text not null,
  detected_entity text,
  target_entity text,
  columns jsonb not null default '[]'::jsonb,
  preview jsonb not null default '[]'::jsonb,
  mapping jsonb,
  status text not null default 'parsed' check (status in ('parsed','mapped','running','completed','failed','rolled_back')),
  rows_total int not null default 0,
  rows_ok int not null default 0,
  rows_skipped int not null default 0,
  rows_failed int not null default 0,
  errors jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade,
  foreign key (org_id, file_id) references files(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Agents, conversations, runs, approvals
-- ---------------------------------------------------------------------------
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  template text not null check (template in ('ceo','sales','marketing','finance','operations','research')),
  name text not null,
  status text not null default 'active' check (status in ('active','paused','archived')),
  current_version int not null default 1,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, workspace_id, template)
);

create table if not exists agent_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agent_id uuid not null,
  version int not null,
  instructions text not null,
  model text not null,
  memory_scopes text[] not null default array['workspace'],
  tool_allowlist text[] not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, agent_id, version),
  unique (org_id, id),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  agent_id uuid not null,
  user_id text not null,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade
);

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('user','assistant','system_notice')),
  content text not null,
  run_id uuid,
  refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, conversation_id) references conversations(org_id, id) on delete cascade
);

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  conversation_id uuid,
  agent_id uuid not null,
  agent_version_id uuid not null,
  initiated_by text not null,
  trigger text not null default 'chat' check (trigger in ('chat','workflow','delegation')),
  status text not null default 'queued' check (status in ('queued','running','waiting_approval','completed','failed','cancelled')),
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  error text,
  correlation_id uuid not null default gen_random_uuid(),
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, agent_id) references agents(org_id, id) on delete cascade
);

create table if not exists run_events (
  id bigserial primary key,
  org_id uuid not null,
  run_id uuid not null,
  seq int not null,
  event text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, seq),
  foreign key (org_id, run_id) references agent_runs(org_id, id) on delete cascade
);

create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid,
  workflow_run_id uuid,
  tool text not null,
  args jsonb not null,
  risk text not null,
  policy_decision text not null check (policy_decision in ('allow','require_approval','deny')),
  idempotency_key text not null,
  status text not null check (status in ('planned','waiting_approval','succeeded','failed','denied','rejected','simulated')),
  result_summary text,
  result_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (org_id, idempotency_key),
  unique (org_id, id)
);

create table if not exists approval_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  requester_kind text not null check (requester_kind in ('agent','workflow')),
  requester_id uuid not null,
  requested_for text not null,
  tool_call_id uuid not null,
  action text not null,
  preview jsonb not null,
  risk text not null check (risk in ('L0','L1','L2','L3','L4')),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired','executed','failed')),
  decided_by_user text,
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- A decision must name the human who made it.
  check ((status in ('pending','expired')) or decided_by_user is not null),
  unique (org_id, id),
  foreign key (org_id, tool_call_id) references tool_calls(org_id, id) on delete cascade
);
create index if not exists approvals_pending on approval_requests(org_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Workflows
-- ---------------------------------------------------------------------------
create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  name text not null,
  description text,
  status text not null default 'disabled' check (status in ('disabled','enabled')),
  published_version int,
  draft jsonb not null,
  owner_id text not null,
  last_scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);

create table if not exists workflow_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workflow_id uuid not null,
  version int not null,
  definition jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, workflow_id, version),
  foreign key (org_id, workflow_id) references workflows(org_id, id) on delete cascade
);

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workflow_id uuid not null,
  version int not null,
  trigger_kind text not null,
  dedupe_key text,
  dry_run boolean not null default false,
  status text not null default 'running' check (status in ('running','waiting_approval','completed','failed','rejected')),
  current_step int not null default 0,
  context jsonb not null default '{}'::jsonb,
  initiated_by text not null,
  error text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (org_id, id),
  unique (org_id, workflow_id, dedupe_key),
  foreign key (org_id, workflow_id) references workflows(org_id, id) on delete cascade
);

create table if not exists workflow_run_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  step_index int not null,
  kind text not null,
  status text not null,
  summary text,
  output jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, run_id) references workflow_runs(org_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Integrations, notifications, audit, idempotency
-- ---------------------------------------------------------------------------
create table if not exists integration_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null,
  status text not null,
  scopes text[] not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id text not null,
  category text not null,
  title text not null,
  body text,
  ref jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user on notifications(org_id, user_id, created_at desc);

create table if not exists audit_events (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('user','agent','workflow','system')),
  actor_id text not null,
  action text not null,
  target_ref text,
  outcome text not null default 'success',
  correlation_id uuid,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  prev_hash text not null,
  hash text not null
);
create index if not exists audit_org_at on audit_events(org_id, id desc);

create table if not exists idempotency_keys (
  org_id uuid not null,
  user_id text not null,
  key text not null,
  route text not null,
  status int not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id, key)
);

-- ---------------------------------------------------------------------------
-- Row-level security
-- RLS is enabled (not forced): the table owner (migrations, SECURITY DEFINER
-- helpers) bypasses it, while qline_app, which owns nothing, is always filtered.
-- ---------------------------------------------------------------------------
create or replace function qline_org() returns uuid language sql stable as $$
  select nullif(current_setting('qline.org_id', true), '')::uuid
$$;
create or replace function qline_user() returns text language sql stable as $$
  select nullif(current_setting('qline.user_id', true), '')
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'workspaces','business_profiles','configuration_versions','onboarding_sessions','projects','tasks',
    'task_comments','companies','contacts','files','documents','memory_records','import_jobs','agents',
    'agent_versions','conversations','conversation_messages','agent_runs','run_events','tool_calls',
    'approval_requests','workflows','workflow_versions','workflow_runs','workflow_run_steps',
    'integration_accounts','notifications','audit_events','idempotency_keys','invitations'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (org_id = qline_org()) with check (org_id = qline_org())', t);
  end loop;
end $$;

-- Members: a user may see their own memberships (to list orgs) plus every row of the active org.
alter table organization_members enable row level security;
drop policy if exists members_read on organization_members;
drop policy if exists members_write on organization_members;
create policy members_read on organization_members for select using (org_id = qline_org() or user_id = qline_user());
create policy members_write on organization_members for all using (org_id = qline_org()) with check (org_id = qline_org());

alter table organizations enable row level security;
drop policy if exists orgs_read on organizations;
drop policy if exists orgs_write on organizations;
create policy orgs_read on organizations for select using (
  id = qline_org() or exists (select 1 from organization_members m where m.org_id = organizations.id and m.user_id = qline_user())
);
create policy orgs_write on organizations for all using (id = qline_org()) with check (id = qline_org());

-- Invitation codes are looked up before the joiner belongs to the org.
-- That lookup goes through a SECURITY DEFINER function that returns one row by hash only.
create or replace function qline_invitation_by_hash(h text)
returns table (id uuid, org_id uuid, role text, status text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select id, org_id, role, status, expires_at from invitations where code_hash = h
$$;
