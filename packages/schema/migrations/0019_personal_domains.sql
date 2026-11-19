-- Personal AI OS phase 7 (docs/21, ADR-1 option B + M11). A person can use Qline without a business: their personal
-- space is an ordinary organization with settings.kind = 'personal' (sole owner, no invitations), so every RLS policy
-- applies unchanged. Domains are labels inside a workspace (Personal, Work, Learning, ...) that tasks can carry.
-- Additive. Recovery: alter table tasks drop column domain_id; drop table domains;
--   (personal organizations are normal organizations and keep working as before).
create table if not exists domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 40),
  icon text not null default 'label' check (icon ~ '^[a-z_]{1,40}$'),
  enabled boolean not null default true,
  position int not null default 0,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);
create index if not exists domains_ws on domains (org_id, workspace_id, position);
alter table domains enable row level security;
drop policy if exists tenant_isolation on domains;
create policy tenant_isolation on domains using (org_id = qline_org()) with check (org_id = qline_org());

alter table tasks add column if not exists domain_id uuid references domains(id) on delete set null;
create index if not exists tasks_domain on tasks (org_id, domain_id) where domain_id is not null;
