-- Content handoff run 5 / Slice 3 (docs/22 ADR-C4): Drive change tracking and reconciliation.
-- - folder_index: the folders found by the last full listing (id, role, depth), so a change can be matched to a mapped
--   folder without listing again.
-- - sync lease: one Drive sync per workspace at a time; a crashed holder's lease simply runs out.
-- - prev_channel_*: the channel being replaced during renewal, accepted until it is stopped or expires.
-- - content_jobs.stale_since: when the reconciliation sweep last flagged the job as quiet past its SLA.
-- Additive. Recovery: drop the two functions and the added columns.
alter table content_drive_config add column if not exists folder_index jsonb not null default '[]'::jsonb;
alter table content_drive_config add column if not exists sync_lease_owner text;
alter table content_drive_config add column if not exists sync_lease_until timestamptz;
alter table content_drive_config add column if not exists prev_channel_id text;
alter table content_drive_config add column if not exists prev_channel_token_hash text;
alter table content_drive_config add column if not exists prev_resource_id text;
alter table content_drive_config add column if not exists prev_channel_expires_at timestamptz;
alter table content_drive_config add column if not exists cursor_reset_at timestamptz;
alter table content_drive_config add column if not exists last_reconcile jsonb;
create unique index if not exists content_drive_config_channel on content_drive_config (channel_id) where channel_id is not null;
create unique index if not exists content_drive_config_prev_channel on content_drive_config (prev_channel_id) where prev_channel_id is not null;

alter table content_jobs add column if not exists stale_since timestamptz;

-- The tick has no tenant: list the workspaces whose reconciliation is due (at most every 10 minutes each).
create or replace function qline_content_due(lim int)
returns table (org_id uuid, workspace_id uuid)
language sql stable security definer set search_path = public as $$
  select c.org_id, c.workspace_id from content_drive_config c
  where c.last_reconciled_at is null or c.last_reconciled_at < now() - interval '10 minutes'
  order by c.last_reconciled_at nulls first
  limit greatest(1, least(lim, 200))
$$;
revoke all on function qline_content_due(int) from public;

-- The Drive webhook has no session: find the workspace that owns a channel. Returns the token hash only, never a token.
create or replace function qline_content_channel(cid text)
returns table (org_id uuid, workspace_id uuid, token_hash text, resource_id text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.org_id, c.workspace_id, c.channel_token_hash, c.resource_id, c.channel_expires_at from content_drive_config c where c.channel_id = cid
  union all
  select c.org_id, c.workspace_id, c.prev_channel_token_hash, c.prev_resource_id, c.prev_channel_expires_at from content_drive_config c where c.prev_channel_id = cid
$$;
revoke all on function qline_content_channel(text) from public;
