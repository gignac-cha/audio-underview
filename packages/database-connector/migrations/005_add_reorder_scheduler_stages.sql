-- Migration: Add DEFERRABLE constraint and reorder RPC for scheduler stages
-- Enables atomic reordering of stages without unique constraint violations

-- Replace UNIQUE constraint with DEFERRABLE version
-- This allows temporary duplicate (scheduler_id, stage_order) values within a transaction
ALTER TABLE scheduler_stages
  DROP CONSTRAINT scheduler_stages_scheduler_id_stage_order_key;

ALTER TABLE scheduler_stages
  ADD CONSTRAINT scheduler_stages_scheduler_id_stage_order_key
  UNIQUE(scheduler_id, stage_order) DEFERRABLE INITIALLY DEFERRED;

-- RPC function to atomically reorder stages
-- Accepts an ordered array of stage IDs and reassigns stage_order 0, 1, 2, ...
-- PostgREST wraps RPC calls in a transaction, so DEFERRABLE constraint
-- only checks uniqueness at commit time
CREATE OR REPLACE FUNCTION reorder_scheduler_stages(
  p_scheduler_id UUID,
  p_stage_ids UUID[]
) RETURNS SETOF scheduler_stages AS $$
DECLARE
  i INTEGER;
  provided_stage_count INTEGER;
  existing_stage_count INTEGER;
BEGIN
  -- Validate that the provided stage identifier array is not empty
  IF COALESCE(array_length(p_stage_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'stage_ids must not be empty';
  END IF;

  -- Count distinct identifiers supplied by the caller
  SELECT COUNT(DISTINCT stage_id)
  INTO provided_stage_count
  FROM unnest(p_stage_ids) AS stage_id;

  -- Count stages that currently belong to this scheduler
  SELECT COUNT(*)
  INTO existing_stage_count
  FROM scheduler_stages
  WHERE scheduler_id = p_scheduler_id;

  -- Validate that the supplied identifiers exactly match the scheduler's stages
  IF provided_stage_count <> existing_stage_count THEN
    RAISE EXCEPTION
      'stage_ids length (%) does not match the number of stages for scheduler % (%)',
      provided_stage_count, p_scheduler_id, existing_stage_count;
  END IF;

  FOR i IN 1..COALESCE(array_length(p_stage_ids, 1), 0) LOOP
    UPDATE scheduler_stages
    SET stage_order = i - 1
    WHERE id = p_stage_ids[i]
      AND scheduler_id = p_scheduler_id;
  END LOOP;

  RETURN QUERY
    SELECT * FROM scheduler_stages
    WHERE scheduler_id = p_scheduler_id
    ORDER BY stage_order;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reorder_scheduler_stages IS 'Atomically reorder stages within a scheduler pipeline. Accepts ordered array of stage IDs.';
