-- Migration: Close waiting stage runs
-- A run that is closed as interrupted must not leave a form stage run waiting
-- for its answer, so fail_scheduler_runs now closes the waiting stage runs of
-- the runs it closes too. This is a file of its own because 017 adds the status
-- 'waiting', and a new enum value cannot be used in the transaction that adds it.
--
-- Staging and development apply every pending file in one transaction, 017 and
-- this one included. The status is therefore compared as text: a 'waiting'
-- literal of the enum type would be read when the function is created, inside
-- that transaction, and fail.
--
-- CREATE OR REPLACE keeps the privileges 011 gave the function: only the
-- service role may call it.
CREATE OR REPLACE FUNCTION fail_scheduler_runs(run_ids UUID[], failed_at TIMESTAMPTZ, failure_message TEXT)
RETURNS SETOF UUID
LANGUAGE sql
SET search_path = ''
AS $$
  WITH failed_runs AS (
    UPDATE public.scheduler_runs
    SET status = 'failed', completed_at = failed_at, error = failure_message
    WHERE id = ANY(run_ids)
      AND status IN ('pending', 'running')
    RETURNING id
  ),
  failed_stage_runs AS (
    UPDATE public.scheduler_stage_runs
    SET status = 'failed', completed_at = GREATEST(failed_at, started_at), error = failure_message
    WHERE run_id IN (SELECT id FROM failed_runs)
      AND status::TEXT IN ('pending', 'running', 'waiting')
  )
  SELECT id FROM failed_runs;
$$;
