-- Migration: Task groups
-- A scheduler stage runs either a crawler or a task group: a set of tasks the
-- platform prepared in advance, implemented by a worker outside the scheduler.
-- This adds the registry of task groups, the stage columns that point at one,
-- and what a stage run records about the group it runs.

-- One row per registered version of a task group. A registered version never
-- changes its schemas: a group that changes them registers a new version, and
-- a stage saved with an older version keeps running that version.
CREATE TABLE task_groups (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  input_schema JSONB NOT NULL,
  settings_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  worker_binding TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, version),
  CONSTRAINT task_groups_id_check CHECK (id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(id) <= 63),
  CONSTRAINT task_groups_version_check CHECK (version >= 1),
  CONSTRAINT task_groups_worker_binding_check CHECK (worker_binding ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  CONSTRAINT task_groups_schemas_check CHECK (
    jsonb_typeof(input_schema) = 'object'
    AND jsonb_typeof(settings_schema) = 'object'
    AND jsonb_typeof(output_schema) = 'object'
  )
);

COMMENT ON TABLE task_groups IS 'Registered task groups, one row per version';
COMMENT ON COLUMN task_groups.input_schema IS 'JSON Schema the previous stage output must match';
COMMENT ON COLUMN task_groups.settings_schema IS 'JSON Schema the settings of a stage must match';
COMMENT ON COLUMN task_groups.output_schema IS 'JSON Schema the output of the group matches';
COMMENT ON COLUMN task_groups.worker_binding IS 'Name of the service binding of the scheduler worker that reaches the worker implementing the group';

-- Only the workers (service role) use this table.
ALTER TABLE task_groups ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION prevent_task_group_schema_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.input_schema IS DISTINCT FROM OLD.input_schema
    OR NEW.settings_schema IS DISTINCT FROM OLD.settings_schema
    OR NEW.output_schema IS DISTINCT FROM OLD.output_schema THEN
    RAISE EXCEPTION 'A registered task group version cannot change; register a new version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_groups_schema_change_trigger
  BEFORE UPDATE ON task_groups
  FOR EACH ROW
  EXECUTE FUNCTION prevent_task_group_schema_change();

-- A stage is a crawler stage or a task group stage. Existing stages are
-- crawler stages. A task group stage has no crawler, no fan-out and no schemas
-- of its own: its formats are those of the task group version it points at.
ALTER TABLE scheduler_stages
  ADD COLUMN stage_type TEXT NOT NULL DEFAULT 'crawler',
  ADD COLUMN task_group_id TEXT,
  ADD COLUMN task_group_version INTEGER,
  ADD COLUMN settings JSONB,
  ALTER COLUMN crawler_id DROP NOT NULL,
  ADD CONSTRAINT scheduler_stages_task_group_fkey
    FOREIGN KEY (task_group_id, task_group_version)
    REFERENCES task_groups (id, version) ON DELETE RESTRICT,
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
    )
  );

COMMENT ON COLUMN scheduler_stages.stage_type IS 'What the stage runs: crawler or task_group';
COMMENT ON COLUMN scheduler_stages.task_group_id IS 'Task group of a task group stage';
COMMENT ON COLUMN scheduler_stages.task_group_version IS 'Registered version the stage was saved with and runs';
COMMENT ON COLUMN scheduler_stages.settings IS 'Settings the user filled in, valid for the settings schema of that version';

-- The stage can be edited or deleted while the group works, so the stage run
-- keeps the group and version it was started with.
ALTER TABLE scheduler_stage_runs
  ADD COLUMN task_group_id TEXT,
  ADD COLUMN task_group_version INTEGER,
  ADD COLUMN progress JSONB,
  ADD CONSTRAINT scheduler_stage_runs_task_group_check
    CHECK ((task_group_id IS NULL) = (task_group_version IS NULL));

COMMENT ON COLUMN scheduler_stage_runs.task_group_id IS 'Task group the stage run was started with; NULL for a crawler stage';
COMMENT ON COLUMN scheduler_stage_runs.task_group_version IS 'Version of the task group the stage run was started with';
COMMENT ON COLUMN scheduler_stage_runs.progress IS 'Latest progress a task group reported: {"message", "completed", "total", "reported_at"}';

-- A run that is closed as interrupted must not leave a stage run in progress,
-- so this function now closes the active stage runs of the runs it closes.
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
      AND status IN ('pending', 'running')
  )
  SELECT id FROM failed_runs;
$$;
