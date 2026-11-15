-- Cross-tenant helpers for the scheduler. SECURITY DEFINER (owner) and return only ids,
-- so the cron tick can find work; every action afterwards runs with that org's RLS context.
create or replace function qline_due_schedules()
returns table (org_id uuid, workflow_id uuid, owner_id text)
language sql stable security definer set search_path = public as $$
  select w.org_id, w.id, w.owner_id from workflows w
  join workflow_versions v on v.workflow_id = w.id and v.version = w.published_version
  where w.status = 'enabled'
    and w.published_version is not null
    and (v.definition->'trigger'->>'type') = 'schedule'
    and extract(hour from now() at time zone 'utc') >= coalesce((v.definition->'trigger'->>'hourUtc')::int, 0)
    and (w.last_scheduled_at is null or w.last_scheduled_at < date_trunc('day', now() at time zone 'utc') at time zone 'utc')
$$;
revoke all on function qline_due_schedules() from public;
