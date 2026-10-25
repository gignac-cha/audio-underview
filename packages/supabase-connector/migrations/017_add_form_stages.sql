-- Migration: Form stages
-- A form stage stops a run, shows the owner a form made from the output of the
-- previous stage, and passes the answer on as the input of the next stage. This
-- adds the status of a stage run that waits for its answer, the form branch of
-- the stage check, and the form a waiting stage run shows.

-- A form stage run waits for its answer with this status; its run stays
-- running. The value is not used elsewhere in this file: a new enum value cannot
-- be used in the transaction that adds it, so 018 uses it.
ALTER TYPE scheduler_run_status ADD VALUE IF NOT EXISTS 'waiting';

-- A form stage has no crawler, no task group, no fan-out and no schemas of its
-- own. Its settings are {"form": <JSON Schema of the answer>, "timeout_minutes":
-- <how long a run waits for the answer>}, which the scheduler checks when the
-- stage is saved.
ALTER TABLE scheduler_stages
  DROP CONSTRAINT scheduler_stages_type_check,
  ADD CONSTRAINT scheduler_stages_type_check CHECK (
    (
      stage_type = 'crawler'
      AND crawler_id IS NOT NULL
      AND task_group_id IS NULL
      AND task_group_version IS NULL
      AND settings IS NULL
    ) OR (
      stage_type = 'task_group'
      AND crawler_id IS NULL
      AND task_group_id IS NOT NULL
      AND task_group_version IS NOT NULL
      AND settings IS NOT NULL
      AND jsonb_typeof(settings) = 'object'
      AND fan_out_field IS NULL
      AND fan_out_strategy = 'compact'
      AND input_schema = '{}'::jsonb
      AND output_schema = '{}'::jsonb
    ) OR (
      stage_type = 'form'
      AND crawler_id IS NULL
      AND task_group_id IS NULL
      AND task_group_version IS NULL
      AND settings IS NOT NULL
      AND jsonb_typeof(settings) = 'object'
      -- Without the IS NOT NULL a missing form would make the branch NULL, which a check lets pass
      AND (settings -> 'form') IS NOT NULL
      AND jsonb_typeof(settings -> 'form') = 'object'
      AND fan_out_field IS NULL
      AND fan_out_strategy = 'compact'
      AND input_schema = '{}'::jsonb
      AND output_schema = '{}'::jsonb
    )
  );

COMMENT ON COLUMN scheduler_stages.stage_type IS 'What the stage runs: crawler, task_group or form';
COMMENT ON COLUMN scheduler_stages.settings IS 'Settings the user filled in: valid for the settings schema of the version on a task group stage, the form definition and the timeout on a form stage';

-- The stage can be edited while the run waits, so the stage run keeps the form
-- it showed: the JSON Schema the answer must match, the fields to draw with
-- their choices, and when the wait ends.
ALTER TABLE scheduler_stage_runs
  ADD COLUMN form JSONB;

COMMENT ON COLUMN scheduler_stage_runs.form IS 'Form a form stage run shows, resolved from its input: {"schema", "fields", "expires_at"}; NULL for other stages';
