-- Add fan_out_strategy column to scheduler_stages
-- 'compact' (default): remove failed items from results
-- 'preserve': keep failed items as null, preserving positional alignment

CREATE TYPE fan_out_strategy AS ENUM ('compact', 'preserve');

ALTER TABLE scheduler_stages
  ADD COLUMN fan_out_strategy fan_out_strategy NOT NULL DEFAULT 'compact';
