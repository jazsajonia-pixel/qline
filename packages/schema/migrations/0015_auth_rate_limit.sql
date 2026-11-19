-- Shared sign-in rate limiting (personal AI OS phase 2). Better Auth's in-memory store was per function instance,
-- so limits reset on every cold start and were not shared between instances. This table is Better Auth's
-- `rateLimit` model (storage: 'database'). It is global like the other auth tables (no tenant data, no RLS):
-- rows are keyed by client IP + auth path, hold only a counter and a timestamp, and Better Auth prunes old rows.
--
-- Additive only. Recovery: drop table if exists "rateLimit"; delete from schema_migrations where name =
-- '0015_auth_rate_limit.sql'; (an API on storage 'memory' ignores the table).

create table if not exists "rateLimit" (
  id text primary key,
  key text not null unique,
  count integer not null,
  "lastRequest" bigint not null
);
create index if not exists rate_limit_last_request on "rateLimit" ("lastRequest");
