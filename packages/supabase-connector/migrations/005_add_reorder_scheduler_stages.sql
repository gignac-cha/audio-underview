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
BEGIN
  FOR i IN 1..array_length(p_stage_ids, 1) LOOP
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
