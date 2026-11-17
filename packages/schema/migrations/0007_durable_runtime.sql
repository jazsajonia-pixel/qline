-- v1.4 Durable Automation Runtime (docs/12): jobs, attempts, transactional outbox.
-- Tenant rows carry org_id with RLS. Cross-tenant worker operations are SECURITY DEFINER
-- functions that only move lease/status data; handlers then run under the job's org context.

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{1,60}$'),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','dead','cancelled')),
  priority int not null default 0,
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5 check (max_attempts between 1 and 25),
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  idempotency_key text,
  parent_id uuid references jobs(id) on delete set null,
  group_id uuid,
  cancel_requested boolean not null default false,
  deadline_at timestamptz,
  last_error text,
  result jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists jobs_idem on jobs (org_id, kind, idempotency_key) where idempotency_key is not null;
create index if not exists jobs_claimable on jobs (priority desc, run_at) where status = 'queued';
create index if not exists jobs_leased on jobs (lease_until) where status = 'running';
create index if not exists jobs_org_status on jobs (org_id, status, created_at desc);
create index if not exists jobs_group on jobs (group_id) where group_id is not null;

create table if not exists job_attempts (
  id bigserial primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  attempt int not null,
  worker text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text check (outcome in ('succeeded','retry','failed','dead','cancelled','lost')),
  error text,
  unique (job_id, attempt)
);

create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  workspace_id uuid,
  type text not null,
  event_key text not null,
  data jsonb not null default '{}'::jsonb,
  actor text not null,
  created_at timestamptz not null default now(),
  relayed_at timestamptz,
  unique (org_id, event_key)
);
create index if not exists outbox_unrelayed on outbox_events (created_at) where relayed_at is null;

do $$
declare t text;
begin
  foreach t in array array['jobs','job_attempts','outbox_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (org_id = qline_org()) with check (org_id = qline_org())', t);
  end loop;
end $$;

-- Workflow runs: queued (waiting for a worker), cancelled, needs_attention (outcome unknown, a human must look).
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'workflow_runs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%';
  if c is not null then execute format('alter table workflow_runs drop constraint %I', c); end if;
  alter table workflow_runs add constraint workflow_runs_status_check
    check (status in ('queued','running','waiting_approval','completed','failed','rejected','cancelled','needs_attention'));
  select conname into c from pg_constraint where conrelid = 'tool_calls'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%status%' and pg_get_constraintdef(oid) like '%planned%';
  if c is not null then execute format('alter table tool_calls drop constraint %I', c); end if;
  alter table tool_calls add constraint tool_calls_status_check
    check (status in ('planned','executing','waiting_approval','succeeded','failed','denied','rejected','simulated','unknown'));
end $$;

-- ---------------------------------------------------------------------------
-- Worker functions (SECURITY DEFINER, owner bypasses RLS). Fencing token = (lease_owner, attempts).
-- ---------------------------------------------------------------------------

-- Claim up to p_limit jobs: queued and due, or running with an expired lease (recovery).
create or replace function qline_claim_jobs(p_worker text, p_limit int, p_lease_seconds int)
returns table (id uuid, org_id uuid, kind text, payload jsonb, attempts int, max_attempts int, idempotency_key text, created_by text, deadline_at timestamptz)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
begin
  -- Cancelled while its worker died: settle as cancelled (it would never be reclaimed otherwise).
  with gone as (
    update jobs j set status = 'cancelled', lease_owner = null, lease_until = null, finished_at = now(), updated_at = now()
     where j.status = 'running' and j.lease_until < now() and j.cancel_requested
     returning j.id, j.attempts
  )
  update job_attempts a set outcome = 'cancelled', ended_at = now() from gone where a.job_id = gone.id and a.attempt = gone.attempts and a.outcome is null;

  -- Expired leases on the last attempt become dead instead of being retried forever.
  with lost as (
    update jobs j set status = 'dead', last_error = coalesce(j.last_error, 'Worker lost its lease on the last attempt'),
                      lease_owner = null, lease_until = null, finished_at = now(), updated_at = now()
     where j.status = 'running' and j.lease_until < now() and j.attempts >= j.max_attempts
     returning j.id, j.attempts, j.kind, j.payload
  )
  , mark as (
    update job_attempts a set outcome = 'lost', ended_at = now() from lost where a.job_id = lost.id and a.attempt = lost.attempts and a.outcome is null
  )
  -- No process is left to run the onGiveUp hook, so flag the workflow run here.
  update workflow_runs r set status = 'needs_attention', error = 'Automation stopped: the worker was lost on its last attempt'
    from lost where lost.kind = 'workflow.advance' and r.id = (lost.payload->>'runId')::uuid and r.status in ('queued','running');

  return query
  with picked as (
    select j.id from jobs j
     where ((j.status = 'queued' and j.run_at <= now()) or (j.status = 'running' and j.lease_until < now()))
       and not j.cancel_requested
     order by j.priority desc, j.run_at
     limit greatest(1, least(p_limit, 50))
     for update skip locked
  ), upd as (
    update jobs j set status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
                      lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(), updated_at = now()
      from picked where j.id = picked.id
    returning j.id, j.org_id, j.kind, j.payload, j.attempts, j.max_attempts, j.idempotency_key, j.created_by, j.deadline_at
  ), att as (
    -- A reclaimed attempt marks the previous one as lost.
    update job_attempts a set outcome = 'lost', ended_at = now() from upd where a.job_id = upd.id and a.attempt = upd.attempts - 1 and a.outcome is null
  ), ins as (
    insert into job_attempts (org_id, job_id, attempt, worker) select upd.org_id, upd.id, upd.attempts, p_worker from upd
    on conflict (job_id, attempt) do nothing
  )
  select upd.id, upd.org_id, upd.kind, upd.payload, upd.attempts, upd.max_attempts, upd.idempotency_key, upd.created_by, upd.deadline_at from upd;
end $$;

-- Inline fast path: claim one specific queued, due job (the request that just enqueued it runs it now).
create or replace function qline_claim_job_by_id(p_id uuid, p_worker text, p_lease_seconds int)
returns table (id uuid, org_id uuid, kind text, payload jsonb, attempts int, max_attempts int, idempotency_key text, created_by text, deadline_at timestamptz)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select j.id from jobs j where j.id = p_id and j.status = 'queued' and j.run_at <= now() and not j.cancel_requested for update skip locked
  ), upd as (
    update jobs j set status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
                      lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(), updated_at = now()
      from picked where j.id = picked.id
    returning j.id, j.org_id, j.kind, j.payload, j.attempts, j.max_attempts, j.idempotency_key, j.created_by, j.deadline_at
  ), ins as (
    insert into job_attempts (org_id, job_id, attempt, worker) select upd.org_id, upd.id, upd.attempts, p_worker from upd
    on conflict (job_id, attempt) do nothing
  )
  select upd.id, upd.org_id, upd.kind, upd.payload, upd.attempts, upd.max_attempts, upd.idempotency_key, upd.created_by, upd.deadline_at from upd;
end $$;

-- Extend the lease. Returns null if this worker no longer holds the job (fenced), else cancel_requested.
create or replace function qline_job_heartbeat(p_id uuid, p_worker text, p_attempt int, p_lease_seconds int)
returns boolean language sql volatile security definer set search_path = public as $$
  update jobs set lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(), updated_at = now()
   where id = p_id and status = 'running' and lease_owner = p_worker and attempts = p_attempt
  returning cancel_requested
$$;

-- Finish an attempt. p_outcome: succeeded | retry | failed | dead | cancelled. Returns false when fenced out.
create or replace function qline_job_finish(p_id uuid, p_worker text, p_attempt int, p_outcome text, p_error text, p_result jsonb, p_retry_at timestamptz)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if p_outcome not in ('succeeded','retry','failed','dead','cancelled') then raise exception 'bad outcome %', p_outcome; end if;
  update jobs set
      status = case p_outcome when 'retry' then 'queued' else p_outcome end,
      run_at = case when p_outcome = 'retry' then coalesce(p_retry_at, now()) else run_at end,
      last_error = coalesce(left(p_error, 2000), case when p_outcome = 'succeeded' then null else last_error end),
      result = coalesce(p_result, result),
      lease_owner = null, lease_until = null, updated_at = now(),
      finished_at = case when p_outcome = 'retry' then null else now() end
   where id = p_id and status = 'running' and lease_owner = p_worker and attempts = p_attempt;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  update job_attempts set outcome = p_outcome, error = left(p_error, 2000), ended_at = now() where job_id = p_id and attempt = p_attempt;
  return true;
end $$;

-- Move unrelayed outbox events into one event.dispatch job each (idempotent by event id).
create or replace function qline_relay_outbox(p_limit int)
returns int language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  with ev as (
    select o.id, o.org_id, o.workspace_id, o.type, o.event_key, o.data, o.actor from outbox_events o
     where o.relayed_at is null order by o.created_at limit greatest(1, least(p_limit, 500)) for update skip locked
  ), j as (
    insert into jobs (org_id, kind, payload, idempotency_key, created_by, max_attempts)
    select ev.org_id, 'event.dispatch',
           jsonb_build_object('eventId', ev.id, 'type', ev.type, 'key', ev.event_key, 'data', ev.data, 'workspaceId', ev.workspace_id, 'actor', ev.actor),
           'event:' || ev.id, 'system:outbox', 8
      from ev
    on conflict do nothing
  )
  update outbox_events o set relayed_at = now() from ev where o.id = ev.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Queue depth for /health/ready and the tick response (counts only, no tenant data).
create or replace function qline_runtime_stats()
returns table (queued bigint, running bigint, dead bigint, unrelayed bigint, oldest_queued_seconds int)
language sql stable security definer set search_path = public as $$
  select (select count(*) from jobs where status = 'queued'),
         (select count(*) from jobs where status = 'running'),
         (select count(*) from jobs where status = 'dead'),
         (select count(*) from outbox_events where relayed_at is null),
         (select extract(epoch from now() - min(run_at))::int from jobs where status = 'queued' and run_at <= now())
$$;

revoke all on function qline_claim_jobs(text, int, int) from public;
revoke all on function qline_job_heartbeat(uuid, text, int, int) from public;
revoke all on function qline_claim_job_by_id(uuid, text, int) from public;
revoke all on function qline_job_finish(uuid, text, int, text, text, jsonb, timestamptz) from public;
revoke all on function qline_relay_outbox(int) from public;
revoke all on function qline_runtime_stats() from public;
