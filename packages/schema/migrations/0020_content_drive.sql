-- Content handoff run 2 / Slice 1 (docs/22 ADR-C1, §E). Drive folder mapping by ID under one root, and an index of the
-- files inside the mapped folders. Drive is a transport only: nothing here is created, moved or written in Drive.
-- The change-cursor and watch-channel columns are used from run 5 (ADR-C4); they are created now so the table is final.
-- Additive. Recovery: drop table content_assets; drop table content_drive_config;
create table if not exists content_drive_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connection_id uuid references integration_connections(id) on delete set null,
  root_folder_id text not null check (length(root_folder_id) between 1 and 200),
  -- role -> folder id (assets -> array of ids). Validated against the root before use.
  roles jsonb not null default '{}'::jsonb,
  status text not null default 'needs_revalidation' check (status in ('unconfigured', 'valid', 'invalid', 'needs_revalidation')),
  validation jsonb not null default '{}'::jsonb,
  validated_at timestamptz,
  -- run 5: Drive changes cursor and push channel (token stored only as a SHA-256 hash)
  start_page_token text,
  cursor_status text not null default 'none' check (cursor_status in ('none', 'ok', 'stale')),
  channel_id text,
  channel_token_hash text,
  resource_id text,
  channel_expires_at timestamptz,
  channel_renewed_at timestamptz,
  last_sync_at timestamptz,
  last_sync jsonb,
  last_success_at timestamptz,
  last_error text,
  last_reconciled_at timestamptz,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id)
);
alter table content_drive_config enable row level security;
drop policy if exists tenant_isolation on content_drive_config;
create policy tenant_isolation on content_drive_config using (org_id = qline_org()) with check (org_id = qline_org());

create table if not exists content_assets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  drive_file_id text not null check (length(drive_file_id) between 1 and 200),
  name text not null,
  mime text not null,
  parent_id text not null,
  role text not null,
  depth int not null default 0,
  size_bytes bigint,
  md5 text,
  sha256 text,
  version bigint,
  head_revision_id text,
  created_at_drive timestamptz,
  modified_at_drive timestamptz,
  width int,
  height int,
  duration_ms bigint,
  web_view_link text,
  state text not null default 'indexed' check (state in ('indexed', 'skipped_shortcut', 'outside_root', 'removed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (workspace_id, drive_file_id)
);
create index if not exists content_assets_role on content_assets (org_id, workspace_id, role, state);
alter table content_assets enable row level security;
drop policy if exists tenant_isolation on content_assets;
create policy tenant_isolation on content_assets using (org_id = qline_org()) with check (org_id = qline_org());
