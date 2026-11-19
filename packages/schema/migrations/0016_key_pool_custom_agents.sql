-- Personal AI OS phase 4 (docs/21): several API keys per provider with routing, and user-created agents.
--
-- 1. ai_keys: every key a workspace owner adds, with a readable alias, health and usage. The first key per provider
--    keeps being mirrored into ai_provider_keys.key_ciphertext so an older API (v1.7) still finds a working key.
--    Backfill copies each existing ai_provider_keys row as the provider's primary key (same ciphertext, legacy AAD).
-- 2. agents: template 'custom' for user-created agents, with description, icon, accent and the built-in profile they
--    are based on (their tool entitlement ceiling). Built-in agents stay unique per workspace; custom ones do not.
-- 3. agent_versions: optional key assignment, approval mode and budgets, all versioned with the instructions.
-- 4. agent_runs.key_id: which key alias served a run (never the secret).
--
-- Additive except the replaced unique constraint on agents (now a partial unique index with the same meaning for
-- built-ins). Recovery / down migration:
--   delete from agents where template = 'custom';   -- (cascades their versions; runs keep agent ids only if retained)
--   drop index if exists agents_builtin_unique;
--   alter table agents add constraint agents_org_id_workspace_id_template_key unique (org_id, workspace_id, template);
--   alter table agents drop constraint if exists agents_template_check;
--   alter table agents add constraint agents_template_check check (template in ('ceo','sales','marketing','finance','operations','research'));
--   alter table agents drop column if exists description, drop column if exists icon, drop column if exists accent,
--     drop column if exists based_on;
--   alter table agent_versions drop column if exists key_id, drop column if exists approval_mode,
--     drop column if exists max_tool_calls, drop column if exists daily_runs, drop column if exists max_concurrent;
--   alter table agent_runs drop column if exists key_id;
--   drop table if exists ai_keys;
--   delete from schema_migrations where name = '0016_key_pool_custom_agents.sql';

create table if not exists ai_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('openai','anthropic','google','xai','deepseek')),
  alias text not null check (length(alias) between 1 and 40),
  key_ciphertext text not null,
  -- true: sealed with the original ai_provider_keys AAD (backfilled rows), false: sealed with the per-key AAD
  legacy_aad boolean not null default false,
  key_hint text not null,
  is_primary boolean not null default false,
  enabled boolean not null default true,
  status text not null default 'ok' check (status in ('ok','invalid','error')),
  status_detail text,
  cooldown_until timestamptz,
  consecutive_limits int not null default 0,
  uses bigint not null default 0,
  failures bigint not null default 0,
  rate_limited bigint not null default 0,
  last_used_at timestamptz,
  last_error_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, provider, alias)
);
create unique index if not exists ai_keys_one_primary on ai_keys (org_id, provider) where is_primary;
create index if not exists ai_keys_pick on ai_keys (org_id, provider, enabled, status, last_used_at);
alter table ai_keys enable row level security;
drop policy if exists tenant_isolation on ai_keys;
create policy tenant_isolation on ai_keys using (org_id = qline_org()) with check (org_id = qline_org());

insert into ai_keys (org_id, provider, alias, key_ciphertext, legacy_aad, key_hint, is_primary, status, status_detail, created_by, created_at)
select k.org_id, k.provider,
       case k.provider when 'google' then 'Gemini key 1' when 'openai' then 'OpenAI key 1' when 'anthropic' then 'Claude key 1'
                       when 'xai' then 'Grok key 1' else 'DeepSeek key 1' end,
       k.key_ciphertext, true, k.key_hint, true, k.status, k.status_detail, k.created_by, k.created_at
  from ai_provider_keys k
 where not exists (select 1 from ai_keys a where a.org_id = k.org_id and a.provider = k.provider and a.is_primary);

-- Custom agents
alter table agents drop constraint if exists agents_template_check;
alter table agents add constraint agents_template_check check (template in ('ceo','sales','marketing','finance','operations','research','custom'));
alter table agents drop constraint if exists agents_org_id_workspace_id_template_key;
create unique index if not exists agents_builtin_unique on agents (org_id, workspace_id, template) where template <> 'custom';
alter table agents add column if not exists description text check (description is null or length(description) <= 300);
alter table agents add column if not exists icon text check (icon is null or icon ~ '^[a-z_]{1,40}$');
alter table agents add column if not exists accent text check (accent is null or accent in ('violet','mint','citrine','coral','sky','rose'));
alter table agents add column if not exists based_on text check (based_on is null or based_on in ('ceo','sales','marketing','finance','operations','research'));
alter table agents drop constraint if exists agents_custom_based_on;
alter table agents add constraint agents_custom_based_on check (template <> 'custom' or based_on is not null);

alter table agent_versions add column if not exists key_id uuid;
alter table agent_versions add column if not exists approval_mode text not null default 'policy' check (approval_mode in ('policy','ask_all'));
alter table agent_versions add column if not exists max_tool_calls int not null default 8 check (max_tool_calls between 0 and 8);
alter table agent_versions add column if not exists daily_runs int check (daily_runs is null or daily_runs between 1 and 1000);
alter table agent_versions add column if not exists max_concurrent int check (max_concurrent is null or max_concurrent between 1 and 5);

alter table agent_runs add column if not exists key_id uuid;
