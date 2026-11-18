-- v1.6 run 3: Knowledge OS foundation + map (docs/14 K1 and K3, scoped) and new connectors
-- (Google Drive, Notion, GitHub, Stripe). Additive: no column is dropped and every existing
-- memory row keeps today's visibility (whole workspace).

-- ---------------------------------------------------------------------------
-- Knowledge categories (seeded per workspace by the API on first use)
-- ---------------------------------------------------------------------------
create table if not exists knowledge_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  workspace_id uuid not null,
  key text not null,
  name text not null check (length(name) between 1 and 60),
  parent_id uuid,
  template_key text,
  customized_at timestamptz,
  sort int not null default 0,
  archived_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, workspace_id, key),
  foreign key (org_id, workspace_id) references workspaces(org_id, id) on delete cascade,
  foreign key (org_id, parent_id) references knowledge_categories(org_id, id)
);

-- ---------------------------------------------------------------------------
-- Entries: memory_records grows into the knowledge entry table (one store, docs/14 §3)
-- ---------------------------------------------------------------------------
alter table memory_records add column if not exists title text;
alter table memory_records add column if not exists body text;
alter table memory_records add column if not exists category_id uuid;
alter table memory_records add column if not exists tags text[] not null default '{}';
-- Default stays 'workspace' so older writers (POST /memory, memory.propose) behave as before.
-- The knowledge API sets 'private' + owner explicitly for new entries.
alter table memory_records add column if not exists visibility text not null default 'workspace';
alter table memory_records add column if not exists owner_user_id text;
alter table memory_records add column if not exists pinned boolean not null default false;
alter table memory_records add column if not exists revision int not null default 1;
alter table memory_records add column if not exists deleted_at timestamptz;
alter table memory_records add column if not exists last_used_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'memory_records_visibility_check') then
    alter table memory_records add constraint memory_records_visibility_check check (visibility in ('private','workspace'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'memory_records_private_owner_check') then
    alter table memory_records add constraint memory_records_private_owner_check check (visibility <> 'private' or owner_user_id is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'memory_records_category_fk') then
    alter table memory_records add constraint memory_records_category_fk foreign key (org_id, category_id) references knowledge_categories(org_id, id);
  end if;
end $$;

alter table memory_records drop constraint if exists memory_records_kind_check;
alter table memory_records add constraint memory_records_kind_check
  check (kind in ('fact','preference','policy','context','process','decision','lesson','note'));

do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'memory_records' and column_name = 'search') then
    alter table memory_records add column search tsvector generated always as (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('simple', coalesce(body, content, '')), 'B')
    ) stored;
  end if;
end $$;
create index if not exists memory_search on memory_records using gin (search);
create index if not exists memory_cat on memory_records (org_id, category_id, status) where deleted_at is null;
create index if not exists memory_owner on memory_records (org_id, owner_user_id) where visibility = 'private';

-- Backfill: existing rows keep workspace visibility; title/body from content.
update memory_records set title = left(regexp_replace(content, '\s+', ' ', 'g'), 80) where title is null;
update memory_records set body = content where body is null;

-- ---------------------------------------------------------------------------
-- Links (the graph's connections) and revisions
-- ---------------------------------------------------------------------------
create table if not exists knowledge_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  from_entry uuid not null,
  to_type text not null check (to_type in ('entry','document','contact','company','project','task')),
  to_id uuid not null,
  relation text not null check (relation in ('about','part_of','depends_on','decided_in','source_of','owned_by','supersedes','contradicts','related_to')),
  source_kind text not null default 'user' check (source_kind in ('user','agent_inferred')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, from_entry, to_type, to_id, relation),
  foreign key (org_id, from_entry) references memory_records(org_id, id) on delete cascade
);
create index if not exists links_from on knowledge_links (org_id, from_entry);
create index if not exists links_to on knowledge_links (org_id, to_type, to_id);

create table if not exists knowledge_revisions (
  org_id uuid not null,
  entry_id uuid not null,
  revision int not null,
  title text,
  body text not null,
  category_id uuid,
  visibility text not null,
  change_kind text not null check (change_kind in ('create','edit','share','unshare','restore','confirm')),
  changed_by text not null,
  changed_at timestamptz not null default now(),
  primary key (org_id, entry_id, revision),
  foreign key (org_id, entry_id) references memory_records(org_id, id) on delete cascade
);

insert into knowledge_revisions (org_id, entry_id, revision, title, body, category_id, visibility, change_kind, changed_by)
select m.org_id, m.id, m.revision, m.title, coalesce(m.body, m.content), m.category_id, m.visibility, 'create', m.created_by
  from memory_records m
 where not exists (select 1 from knowledge_revisions r where r.org_id = m.org_id and r.entry_id = m.id);

-- ---------------------------------------------------------------------------
-- RLS: tenant isolation on the new tables, plus a restrictive visibility policy (docs/14 §5.2).
-- Private entries are visible only to their owner, and only in interactive requests:
-- background jobs, missions and workflows run with qline.run_kind <> 'interactive' and never see them,
-- even though qline.user_id is the person who started the work. A missing setting fails closed.
-- ---------------------------------------------------------------------------
create or replace function qline_interactive() returns boolean language sql stable as $$
  select coalesce(current_setting('qline.run_kind', true), '') = 'interactive'
$$;

do $$
declare t text;
begin
  foreach t in array array['knowledge_categories','knowledge_links','knowledge_revisions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (org_id = qline_org()) with check (org_id = qline_org())', t);
  end loop;
end $$;

drop policy if exists knowledge_visibility on memory_records;
create policy knowledge_visibility on memory_records as restrictive
  using (visibility = 'workspace' or (owner_user_id = qline_user() and qline_interactive()))
  with check (visibility = 'workspace' or owner_user_id = qline_user());

-- Links and revisions are only visible through an entry the caller can see.
drop policy if exists knowledge_link_visibility on knowledge_links;
create policy knowledge_link_visibility on knowledge_links as restrictive
  using (exists (select 1 from memory_records m where m.org_id = knowledge_links.org_id and m.id = knowledge_links.from_entry))
  with check (exists (select 1 from memory_records m where m.org_id = knowledge_links.org_id and m.id = knowledge_links.from_entry));

drop policy if exists knowledge_revision_visibility on knowledge_revisions;
create policy knowledge_revision_visibility on knowledge_revisions as restrictive
  using (exists (select 1 from memory_records m where m.org_id = knowledge_revisions.org_id and m.id = knowledge_revisions.entry_id))
  with check (exists (select 1 from memory_records m where m.org_id = knowledge_revisions.org_id and m.id = knowledge_revisions.entry_id));

-- ---------------------------------------------------------------------------
-- Connectors: Notion and GitHub sign in with OAuth (platform app registered by the owner);
-- Stripe connects per organization with a restricted API key (sealed like OAuth tokens).
-- ---------------------------------------------------------------------------
alter table platform_oauth_apps drop constraint if exists platform_oauth_apps_provider_check;
alter table platform_oauth_apps add constraint platform_oauth_apps_provider_check check (provider in ('google','microsoft','slack','notion','github'));
alter table integration_connections drop constraint if exists integration_connections_provider_check;
alter table integration_connections add constraint integration_connections_provider_check check (provider in ('google','microsoft','slack','notion','github','stripe'));

-- ---------------------------------------------------------------------------
-- New tools on each agent's current version (same pattern as 0009–0011).
-- ---------------------------------------------------------------------------
update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array[
     'knowledge.search','knowledge.propose','knowledge.link',
     'drive.search','drive.read','notion.search','notion.read','github.repos','github.issues','github.read','stripe.summary','stripe.list'
   ]) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version;

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['drive.create','drive.update','drive.save_to_library','notion.create','notion.append']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','sales','marketing','operations','finance');

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['github.issue.create','github.issue.comment']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','operations');

update agent_versions v
   set tool_allowlist = array(select distinct t from unnest(v.tool_allowlist || array['stripe.customer.create','stripe.invoice.draft']) t order by t)
  from agents a
 where a.id = v.agent_id and v.version = a.current_version and a.template in ('ceo','finance','sales');
