-- Migration: Create scheduler tables for pipeline orchestration
-- A scheduler chains multiple crawlers into stages and executes them sequentially

-- Schedulers table
CREATE TABLE schedulers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expression TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX schedulers_user_uuid_index ON schedulers(user_uuid);

COMMENT ON TABLE schedulers IS 'Pipeline definitions that chain crawlers into sequential stages';
COMMENT ON COLUMN schedulers.user_uuid IS 'Reference to the owning user account';
COMMENT ON COLUMN schedulers.name IS 'Human-readable name for the scheduler';
COMMENT ON COLUMN schedulers.cron_expression IS 'Optional cron schedule for automatic execution';
COMMENT ON COLUMN schedulers.is_enabled IS 'Whether automatic execution is enabled';
COMMENT ON COLUMN schedulers.last_run_at IS 'Timestamp of the most recent execution';

-- Auto-refresh updated_at on row updates
CREATE OR REPLACE FUNCTION update_schedulers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedulers_updated_at_trigger
  BEFORE UPDATE ON schedulers
  FOR EACH ROW
  EXECUTE FUNCTION update_schedulers_updated_at();

-- Scheduler stages table
-- Each stage references a crawler and defines input/output schema for the pipeline
CREATE TABLE scheduler_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduler_id UUID NOT NULL REFERENCES schedulers(id) ON DELETE CASCADE,
  crawler_id UUID NOT NULL REFERENCES crawlers(id) ON DELETE RESTRICT,
  stage_order INTEGER NOT NULL CHECK (stage_order >= 0),
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL DEFAULT '{}',
  fan_out_field TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(scheduler_id, stage_order)
);

COMMENT ON TABLE scheduler_stages IS 'Stages within a scheduler pipeline, each referencing a crawler';
COMMENT ON COLUMN scheduler_stages.crawler_id IS 'Reference to the crawler to execute (RESTRICT prevents deleting in-use crawlers)';
COMMENT ON COLUMN scheduler_stages.stage_order IS 'Execution order within the pipeline (0-based)';
COMMENT ON COLUMN scheduler_stages.input_schema IS 'JSON Schema defining stage input with optional defaults (e.g. { url: { type: "string", default: "https://..." } })';
COMMENT ON COLUMN scheduler_stages.output_schema IS 'JSON Schema defining stage output, derived from crawler output_schema';
COMMENT ON COLUMN scheduler_stages.fan_out_field IS 'Field name in previous stage output to fan-out over (null if no fan-out)';

-- Run status enum
CREATE TYPE scheduler_run_status AS ENUM (
  'pending', 'running', 'completed', 'failed', 'partially_failed'
);

-- Scheduler runs table
-- Tracks execution history for each scheduler (update-in-place for top-level status)
CREATE TABLE scheduler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduler_id UUID NOT NULL REFERENCES schedulers(id) ON DELETE CASCADE,
  status scheduler_run_status NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX scheduler_runs_scheduler_id_index ON scheduler_runs(scheduler_id);

COMMENT ON TABLE scheduler_runs IS 'Execution history for scheduler pipelines';
COMMENT ON COLUMN scheduler_runs.status IS 'Run status: pending, running, completed, failed, partially_failed';

-- Scheduler stage runs table
-- Per-stage execution records for debugging and UI display
CREATE TABLE scheduler_stage_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  stage_id UUID NOT NULL REFERENCES scheduler_stages(id) ON DELETE CASCADE,
  stage_order INTEGER NOT NULL CHECK (stage_order >= 0),
  status scheduler_run_status NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input JSONB,
  output JSONB,
  error TEXT,
  items_total INTEGER CHECK (items_total >= 0),
  items_succeeded INTEGER CHECK (items_succeeded >= 0),
  items_failed INTEGER CHECK (items_failed >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  CHECK (items_total IS NULL OR items_succeeded IS NULL OR items_failed IS NULL OR items_succeeded + items_failed <= items_total)
);

CREATE INDEX scheduler_stage_runs_run_id_index ON scheduler_stage_runs(run_id);

COMMENT ON TABLE scheduler_stage_runs IS 'Per-stage execution records within a scheduler run';
COMMENT ON COLUMN scheduler_stage_runs.items_total IS 'Fan-out: total items processed';
COMMENT ON COLUMN scheduler_stage_runs.items_succeeded IS 'Fan-out: items that completed successfully';
COMMENT ON COLUMN scheduler_stage_runs.items_failed IS 'Fan-out: items that failed';
