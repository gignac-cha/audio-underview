-- Migration: Prevent concurrent runs for the same scheduler
-- Only one run with status 'pending' or 'running' can exist per scheduler at a time.
-- When a run completes (completed/failed/partially_failed), the index no longer blocks new runs.

-- Clean up duplicate active runs before creating the unique index.
-- Keeps the most recent active run per scheduler, marks others as failed.
UPDATE scheduler_runs
SET status = 'failed', error = 'Cleaned up by migration 006', completed_at = NOW()
WHERE id NOT IN (
  SELECT DISTINCT ON (scheduler_id) id
  FROM scheduler_runs
  WHERE status IN ('pending', 'running')
  ORDER BY scheduler_id, created_at DESC
)
AND status IN ('pending', 'running');

CREATE UNIQUE INDEX scheduler_runs_one_active_per_scheduler
  ON scheduler_runs (scheduler_id)
  WHERE status IN ('pending', 'running');
