-- Least-privilege runtime role. Password is injected by migrate.mjs (:'app_password' placeholder).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'qline_app') then
    execute format('create role qline_app login nobypassrls password %L', '__APP_PASSWORD__');
  else
    execute format('alter role qline_app login nobypassrls password %L', '__APP_PASSWORD__');
  end if;
end $$;

grant usage on schema public to qline_app;
grant select, insert, update, delete on all tables in schema public to qline_app;
grant usage, select on all sequences in schema public to qline_app;
grant execute on all functions in schema public to qline_app;

-- Audit log is append-only for the app.
revoke update, delete, truncate on audit_events from qline_app;
-- Migrations bookkeeping is owner-only.
revoke all on schema_migrations from qline_app;

-- v1.5 missions: history is kept; the app may not delete mission rows (docs/13 §6).
do $$ begin
  if to_regclass('public.missions') is not null then
    revoke delete, truncate on workspace_controls, missions, mission_plans, mission_tasks, mission_trace from qline_app;
  end if;
end $$;
