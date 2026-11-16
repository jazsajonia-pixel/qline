-- v1.2: real OAuth integrations (Google, Microsoft, Slack) and the email/form/sheet lead pipeline.

-- Platform-level OAuth app registrations (one per provider). Set by platform admins in the app;
-- the client secret is AES-256-GCM sealed by the API. Not tenant data, so no RLS.
create table if not exists platform_oauth_apps (
  provider text primary key check (provider in ('google','microsoft','slack')),
  client_id text not null,
  secret_ciphertext text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

-- One connection per provider per organization. Tokens are sealed JSON.
create table if not exists integration_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null,
  provider text not null check (provider in ('google','microsoft','slack')),
  account_email text,
  account_name text,
  scopes text[] not null default '{}',
  token_ciphertext text not null,
  status text not null default 'ok' check (status in ('ok','expired','error')),
  status_detail text,
  settings jsonb not null default '{}'::jsonb,
  cursor jsonb not null default '{}'::jsonb,
  connected_by text not null,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, provider)
);
alter table integration_connections enable row level security;
drop policy if exists tenant_isolation on integration_connections;
create policy tenant_isolation on integration_connections using (org_id = qline_org()) with check (org_id = qline_org());

-- Short-lived OAuth state (looked up by the public callback before any tenant context exists).
create table if not exists oauth_states (
  state text primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null,
  user_id text not null,
  provider text not null,
  features text[] not null default '{}',
  verifier text,
  created_at timestamptz not null default now()
);

-- Every inbound email / form response / sheet row the pipeline looked at, lead or not.
create table if not exists lead_inbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null,
  source text not null check (source in ('gmail','outlook','form','sheet')),
  external_id text not null,
  from_email text,
  from_name text,
  subject text,
  snippet text,
  received_at timestamptz,
  is_lead boolean not null default false,
  urgency text check (urgency in ('low','normal','high','urgent')),
  score int,
  summary text,
  reason text,
  classified_by text not null default 'rules' check (classified_by in ('rules','ai')),
  contact_id uuid,
  status text not null default 'new' check (status in ('new','lead','ignored','error')),
  created_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);
alter table lead_inbox enable row level security;
drop policy if exists tenant_isolation on lead_inbox;
create policy tenant_isolation on lead_inbox using (org_id = qline_org()) with check (org_id = qline_org());
create index if not exists lead_inbox_recent on lead_inbox(org_id, created_at desc);

alter table contacts add column if not exists urgency text check (urgency is null or urgency in ('low','normal','high','urgent'));
alter table contacts add column if not exists lead_score int;
alter table contacts add column if not exists lead_summary text;
alter table contacts add column if not exists last_inbound_at timestamptz;

-- Cross-tenant helper for the cron tick: ids only; work then runs under each org's RLS context.
create or replace function qline_due_syncs()
returns table (org_id uuid, workspace_id uuid, connection_id uuid, provider text, connected_by text)
language sql stable security definer set search_path = public as $$
  select c.org_id, c.workspace_id, c.id, c.provider, c.connected_by from integration_connections c
  where c.status = 'ok' and c.provider in ('google','microsoft')
    and (c.last_sync_at is null or c.last_sync_at < now() - interval '10 minutes')
$$;
revoke all on function qline_due_syncs() from public;
