-- Migration: Prevent concurrent runs for the same scheduler
-- Only one run with status 'pending' or 'running' can exist per scheduler at a time.
-- When a run completes (completed/failed/partially_failed), the index no longer blocks new runs.

CREATE UNIQUE INDEX scheduler_runs_one_active_per_scheduler
  ON scheduler_runs (scheduler_id)
  WHERE status IN ('pending', 'running');
