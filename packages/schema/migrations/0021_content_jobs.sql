-- Content handoff run 3 / Slice 2a (docs/22 ADR-C2, C5, C7, §E). A content job hands selected indexed assets to an
-- external editor. Qline's database is authoritative: the manifest is stored here as the exact JSON text that was issued
-- (with its SHA-256), together with the exact editor PDF bytes that were issued (pdf, pdf_sha256).
-- Additive. Recovery: drop table content_job_acks, content_job_outputs, content_job_events, content_jobs;
--   drop index notifications_dedupe; alter table notifications drop column dedupe_key;
create table if not exists content_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  job_code text not null check (job_code ~ '^QLINE-[0-9]{8}-[0-9a-hjkmnp-tv-z]{6}$'),
  mission_id uuid references missions(id) on delete set null,
  title text not null check (length(title) between 1 and 120),
  brief text not null default '' check (length(brief) <= 4000),
  editor_target text not null check (editor_target ~ '^[a-z0-9_-]{1,40}$'),
  qline_state text not null default 'prepared' check (qline_state in ('prepared', 'dispatched', 'external_acknowledged', 'external_in_progress',
    'result_received', 'validating_output', 'output_verified', 'awaiting_video_qa', 'needs_manual_review', 'failed', 'blocked', 'expired', 'cancelled')),
  -- what the editor last reported; never drives qline_state by itself (ADR-C2)
  external_status text check (external_status in ('accepted', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled')),
  nonce text not null,
  revision int not null default 1 check (revision >= 1),
  input_file_ids text[] not null,
  constraints jsonb not null default '{}'::jsonb,
  expected_outputs jsonb not null default '[]'::jsonb,
  manifest_json text not null,
  manifest_sha256 text not null,
  pdf bytea not null,
  pdf_sha256 text not null,
  drive_package jsonb not null default '{}'::jsonb,
  qa_mission_id uuid unique,
  cancel_reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  issued_at timestamptz not null default now(),
  dispatched_at timestamptz,
  last_activity_at timestamptz not null default now(),
  result_received_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (org_id, job_code)
);
create index if not exists content_jobs_ws on content_jobs (org_id, workspace_id, qline_state, last_activity_at desc);

create table if not exists content_job_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references content_jobs(id) on delete cascade,
  source text not null check (source in ('qline', 'external', 'drive')),
  event_key text not null check (length(event_key) between 1 and 200),
  revision int not null,
  sequence int,
  event_type text not null check (event_type ~ '^[a-z_.]{1,60}$'),
  message text check (length(message) <= 2000),
  file_ids text[] not null default '{}',
  detail jsonb not null default '{}'::jsonb,
  raw_sha256 text,
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  unique (job_id, source, event_key)
);
create index if not exists content_job_events_job on content_job_events (org_id, job_id, occurred_at);

create table if not exists content_job_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references content_jobs(id) on delete cascade,
  revision int not null,
  drive_file_id text not null,
  name text not null,
  mime text not null,
  size_bytes bigint,
  md5 text,
  parent_id text,
  web_view_link text,
  verification text not null check (verification in ('verified', 'rejected')),
  findings jsonb not null default '[]'::jsonb,
  verified_at timestamptz not null default now(),
  unique (job_id, drive_file_id)
);

create table if not exists content_job_acks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references content_jobs(id) on delete cascade,
  revision int not null,
  version int not null,
  status text not null check (status in ('accepted', 'rejected')),
  findings jsonb not null default '[]'::jsonb,
  verified_output_ids text[] not null default '{}',
  validation_version int not null,
  correlation_id text,
  drive_file_id text,
  sha256 text not null,
  created_at timestamptz not null default now(),
  unique (job_id, version)
);

do $$ declare t text; begin
  foreach t in array array['content_jobs', 'content_job_events', 'content_job_outputs', 'content_job_acks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (org_id = qline_org()) with check (org_id = qline_org())', t);
  end loop;
end $$;

-- run 4 creates deduplicated notifications (one per job event per person)
alter table notifications add column if not exists dedupe_key text check (length(dedupe_key) <= 200);
create unique index if not exists notifications_dedupe on notifications (org_id, user_id, dedupe_key) where dedupe_key is not null;
