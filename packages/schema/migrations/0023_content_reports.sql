-- Content handoff run 4 / Slice 2b (docs/22 ADR-C2, C3, C7): report ingestion, output verification, DB acknowledgement.
-- The video QA step is a human review task, not a mission (missions start model planning, and report text must never
-- reach a model prompt), so qa_mission_id becomes qa_task_id. Branch-only: 0021 has never run in production.
-- Recovery: alter table content_jobs rename column qa_task_id to qa_mission_id; drop the added columns.
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'content_jobs' and column_name = 'qa_mission_id') then
    alter table content_jobs rename column qa_mission_id to qa_task_id;
  end if;
end $$;
alter table content_jobs add column if not exists last_error text check (length(last_error) <= 500);
alter table content_job_outputs add column if not exists version bigint;
alter table content_job_acks add column if not exists report_sha256 text;
alter table content_drive_config add column if not exists last_reports_check_at timestamptz;
alter table content_drive_config add column if not exists last_reports_check jsonb;
