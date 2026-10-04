-- Migration: Scheduled runs
-- A scheduler with a cron expression runs on its own. This adds what a
-- scheduler needs to know when it runs next, and what a run records about the
-- occurrence it belongs to.

-- A scheduled occurrence that cannot start because the previous run is still
-- in progress is recorded with this status. The value is not used elsewhere in
-- this file: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE scheduler_run_status ADD VALUE IF NOT EXISTS 'skipped';

ALTER TABLE schedulers
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  ADD COLUMN next_run_at TIMESTAMPTZ;

COMMENT ON COLUMN schedulers.timezone IS 'IANA time zone the cron expression is evaluated in';
COMMENT ON COLUMN schedulers.next_run_at IS 'Next scheduled occurrence; NULL when the scheduler is disabled or has no cron expression';

-- Schedulers run on a 10-minute tick, so a stored cron expression must only
-- name minutes 0, 10, 20, 30, 40 or 50. Each minute an existing minute field
-- names is rounded down to a multiple of 10, and the field is rewritten as the
-- sorted list of those minutes: '5 9 * * *' becomes '0 9 * * *' and
-- '*/15 * * * *' becomes '0,10,30,40 * * * *'. Rounding down never changes
-- the hour or the day; such a scheduler runs up to 9 minutes earlier.
CREATE FUNCTION pg_temp.round_schedule_minutes(minute_field TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  minutes INTEGER[] := ARRAY[]::INTEGER[];
  part TEXT;
BEGIN
  -- A step of 60 or more names the first minute only, so steps are capped at
  -- 60 before the cast; the save check allows steps with any number of digits.
  IF minute_field ~ '^\*(/[1-9][0-9]*)?$' THEN
    minutes := ARRAY(SELECT generate_series(0, 59, LEAST(COALESCE(substring(minute_field FROM '/([0-9]+)$')::NUMERIC, 1), 60)::INTEGER));
  ELSIF minute_field ~ '^[0-9]{1,2}/[1-9][0-9]*$' THEN
    minutes := ARRAY(SELECT generate_series(split_part(minute_field, '/', 1)::INTEGER, 59, LEAST(split_part(minute_field, '/', 2)::NUMERIC, 60)::INTEGER));
  ELSIF minute_field ~ '^[0-9]{1,2}(-[0-9]{1,2})?(,[0-9]{1,2}(-[0-9]{1,2})?)*$' THEN
    FOREACH part IN ARRAY string_to_array(minute_field, ',') LOOP
      minutes := minutes || ARRAY(SELECT generate_series(
        split_part(part, '-', 1)::INTEGER,
        COALESCE(NULLIF(split_part(part, '-', 2), '')::INTEGER, split_part(part, '-', 1)::INTEGER)
      ));
    END LOOP;
  ELSE
    RETURN NULL;
  END IF;

  IF cardinality(minutes) = 0 OR 59 < ANY (minutes) THEN
    RETURN NULL;
  END IF;

  RETURN (
    SELECT string_agg(rounded_minute::TEXT, ',' ORDER BY rounded_minute)
    FROM (SELECT DISTINCT (minute / 10) * 10 AS rounded_minute FROM unnest(minutes) AS minute) AS rounded_minutes
  );
END;
$$;

WITH split_expressions AS (
  SELECT
    id,
    substring(btrim(cron_expression, E' \t\n\r') FROM '^(\S+)') AS minute_field,
    substring(btrim(cron_expression, E' \t\n\r') FROM '^\S+(\s.*)$') AS remaining_fields
  FROM schedulers
  WHERE cron_expression IS NOT NULL
),
rounded_expressions AS (
  SELECT id, pg_temp.round_schedule_minutes(minute_field) || remaining_fields AS cron_expression
  FROM split_expressions
  WHERE minute_field !~ '^(\*/(10|20|30)|(0|10|20|30|40|50)(,(0|10|20|30|40|50))*)$'
)
UPDATE schedulers
SET cron_expression = rounded_expressions.cron_expression
FROM rounded_expressions
WHERE schedulers.id = rounded_expressions.id
  AND rounded_expressions.cron_expression IS NOT NULL;

DROP FUNCTION pg_temp.round_schedule_minutes(TEXT);

CREATE INDEX schedulers_next_run_at_index
  ON schedulers (next_run_at)
  WHERE next_run_at IS NOT NULL;

ALTER TABLE scheduler_runs
  ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN scheduled_for TIMESTAMPTZ,
  ADD CONSTRAINT scheduler_runs_triggered_by_check
    CHECK (triggered_by IN ('manual', 'schedule')),
  ADD CONSTRAINT scheduler_runs_scheduled_for_check
    CHECK ((triggered_by = 'schedule') = (scheduled_for IS NOT NULL));

COMMENT ON COLUMN scheduler_runs.triggered_by IS 'What started the run: manual (API call) or schedule (cron occurrence)';
COMMENT ON COLUMN scheduler_runs.scheduled_for IS 'The cron occurrence a scheduled run belongs to; NULL for manual runs';

-- One run per scheduled occurrence, so a repeated trigger cannot run it twice.
CREATE UNIQUE INDEX scheduler_runs_scheduled_occurrence_unique_index
  ON scheduler_runs (scheduler_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL;

-- The 10-minute tick moves next_run_at for many schedulers and closes many
-- interrupted runs. One request per row would exceed the Workers Free limit of
-- 50 external requests per invocation, so each kind of change is one call.

-- Moves next_run_at for many schedulers. Each element of updates is
-- {"id": uuid, "expected_next_run_at": timestamptz or null,
--  "next_run_at": timestamptz or null}. A scheduler changes only while its
-- next_run_at is still the expected value, so one a user edited in the
-- meantime is left alone. Returns the IDs that changed.
CREATE FUNCTION set_scheduler_next_runs(updates JSONB)
RETURNS SETOF UUID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.schedulers
  SET next_run_at = requested.next_run_at
  FROM jsonb_to_recordset(updates) AS requested(id UUID, expected_next_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ)
  WHERE schedulers.id = requested.id
    AND schedulers.next_run_at IS NOT DISTINCT FROM requested.expected_next_run_at
  RETURNING schedulers.id;
$$;

-- Closes many interrupted runs. Only runs still pending or running change, so
-- a run that finished in the meantime keeps its result. Returns the IDs that
-- changed.
CREATE FUNCTION fail_scheduler_runs(run_ids UUID[], failed_at TIMESTAMPTZ, failure_message TEXT)
RETURNS SETOF UUID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.scheduler_runs
  SET status = 'failed', completed_at = failed_at, error = failure_message
  WHERE id = ANY(run_ids)
    AND status IN ('pending', 'running')
  RETURNING id;
$$;

-- Only the service role (the workers) may call these functions. The public
-- anon and authenticated keys must not change scheduling data. The roles exist
-- on Supabase only, hence the check.
REVOKE EXECUTE ON FUNCTION set_scheduler_next_runs(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_scheduler_runs(UUID[], TIMESTAMPTZ, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION set_scheduler_next_runs(JSONB) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION fail_scheduler_runs(UUID[], TIMESTAMPTZ, TEXT) FROM anon, authenticated;
    GRANT EXECUTE ON FUNCTION set_scheduler_next_runs(JSONB) TO service_role;
    GRANT EXECUTE ON FUNCTION fail_scheduler_runs(UUID[], TIMESTAMPTZ, TEXT) TO service_role;
  END IF;
END;
$$;
