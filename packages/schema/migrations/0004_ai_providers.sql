-- Bring-your-own-key AI providers (v1.1). Keys are AES-256-GCM encrypted by the API
-- (QLINE_DATA_KEY) before they reach the database; only the last 4 chars are kept in clear.
create table if not exists ai_provider_keys (
  org_id uuid not null references organizations(id) on delete cascade,
  provider text not null check (provider in ('openai','anthropic','google','xai','deepseek')),
  key_ciphertext text not null,
  key_hint text not null,
  status text not null default 'ok' check (status in ('ok','invalid','error')),
  status_detail text,
  models jsonb not null default '[]'::jsonb,
  checked_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider)
);
alter table ai_provider_keys enable row level security;
drop policy if exists tenant_isolation on ai_provider_keys;
create policy tenant_isolation on ai_provider_keys using (org_id = qline_org()) with check (org_id = qline_org());

-- Per-agent assignment. provider null = use the organization's default model.
alter table agent_versions add column if not exists provider text
  check (provider is null or provider in ('openai','anthropic','google','xai','deepseek'));
