-- v1.11 Facebook Pages (docs/27). Pages an organization connected, and every post Qline published or scheduled there.
-- Facebook only: no Instagram or other platforms. Page tokens are sealed per organization (AES-GCM, docs/05) and never
-- leave the API. Posts are kept as history (the app may not delete them; cancelling a scheduled post marks it cancelled).
-- Additive. Recovery: drop table facebook_posts; drop table facebook_pages; delete the 'facebook' rows from
-- integration_connections and platform_oauth_apps and restore the two provider checks from 0012; restore files_source_check without 'social'
-- (after removing those files); then remove 'facebook.pages' and
-- 'facebook.post' from agent_versions.tool_allowlist with array_remove on the current versions.
-- Facebook becomes an OAuth provider (same constraint pattern as 0012).
alter table platform_oauth_apps drop constraint if exists platform_oauth_apps_provider_check;
alter table platform_oauth_apps add constraint platform_oauth_apps_provider_check check (provider in ('google','microsoft','slack','notion','github','facebook'));
alter table integration_connections drop constraint if exists integration_connections_provider_check;
alter table integration_connections add constraint integration_connections_provider_check check (provider in ('google','microsoft','slack','notion','github','stripe','facebook'));

create table if not exists facebook_pages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  connection_id uuid references integration_connections(id) on delete set null,
  page_id text not null check (page_id ~ '^[0-9]{1,30}$'),
  name text not null check (length(name) between 1 and 200),
  category text,
  picture_url text,
  tasks text[] not null default '{}',
  token_ciphertext text,
  -- ok: Qline can post. no_access: listed but the person cannot create content there. removed: no longer returned by Facebook.
  status text not null default 'ok' check (status in ('ok', 'no_access', 'removed')),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, page_id)
);
alter table facebook_pages enable row level security;
drop policy if exists tenant_isolation on facebook_pages;
create policy tenant_isolation on facebook_pages using (org_id = qline_org()) with check (org_id = qline_org());

create table if not exists facebook_posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  page_ref uuid not null references facebook_pages(id) on delete cascade,
  kind text not null check (kind in ('text', 'link', 'photo', 'video')),
  message text not null default '' check (length(message) <= 5000),
  link text,
  title text,
  file_id uuid,
  media_name text,
  media_mime text,
  media_bytes bigint,
  schedule_at timestamptz,
  -- SHA-256 of exactly what the person approved (page, kind, text, link, title, media hash, time).
  content_hash text not null,
  status text not null check (status in ('publishing', 'scheduled', 'processing', 'published', 'failed', 'cancelled', 'unknown')),
  source text not null check (source in ('user', 'agent')),
  request_key text,
  approval_id uuid,
  tool_call_id uuid,
  fb_object_id text,
  fb_post_id text,
  permalink text,
  error_kind text,
  error text,
  created_by text not null,
  -- the person told when it goes live or fails (the requester for AI posts)
  notify_user text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  last_checked_at timestamptz,
  unique (org_id, request_key),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade
);
create index if not exists facebook_posts_ws on facebook_posts (org_id, workspace_id, created_at desc);
create index if not exists facebook_posts_open on facebook_posts (status, schedule_at) where status in ('scheduled', 'processing', 'publishing');
alter table facebook_posts enable row level security;
drop policy if exists tenant_isolation on facebook_posts;
create policy tenant_isolation on facebook_posts using (org_id = qline_org()) with check (org_id = qline_org());

-- Photos and videos uploaded for a Facebook post are files with source 'social' (served by the same permission-checked
-- /files routes; never public).
alter table files drop constraint if exists files_source_check;
alter table files add constraint files_source_check check (source in ('import','chat','drive','social'));

-- facebook.pages (read) joins every built-in agent; facebook.post (always approved) joins the built-in CEO and
-- Marketing agents. Same pattern as 0025. Custom agents keep their own lists.
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['facebook.pages']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template <> 'custom';

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['facebook.post']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo', 'marketing');
