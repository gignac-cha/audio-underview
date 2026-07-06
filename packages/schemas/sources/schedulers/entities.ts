import { z } from 'zod';
import { plainObjectSchema } from '../common/json-objects.ts';

export const schedulerSchema = z.object({
  id: z.uuid(),
  user_uuid: z.uuid(),
  name: z.string(),
  cron_expression: z.string().nullable(),
  is_enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Scheduler = z.infer<typeof schedulerSchema>;

export const fanOutStrategySchema = z.enum(['compact', 'preserve']);
export type FanOutStrategy = z.infer<typeof fanOutStrategySchema>;

export const schedulerStageSchema = z.object({
  id: z.uuid(),
  scheduler_id: z.uuid(),
  crawler_id: z.uuid(),
  stage_order: z.number().int().min(0),
  input_schema: plainObjectSchema,
  output_schema: plainObjectSchema,
  fan_out_field: z.string().nullable(),
  fan_out_strategy: fanOutStrategySchema,
  created_at: z.string(),
});

export type SchedulerStage = z.infer<typeof schedulerStageSchema>;

export const schedulerRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'partially_failed',
]);
export type SchedulerRunStatus = z.infer<typeof schedulerRunStatusSchema>;

export const schedulerRunSchema = z.object({
  id: z.uuid(),
  scheduler_id: z.uuid(),
  status: schedulerRunStatusSchema,
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  result: z.unknown(),
  error: z.string().nullable(),
  created_at: z.string(),
});

export type SchedulerRun = z.infer<typeof schedulerRunSchema>;

export const schedulerStageRunSchema = z.object({
  id: z.uuid(),
  run_id: z.uuid(),
  stage_id: z.uuid(),
  stage_order: z.number().int().min(0),
  status: schedulerRunStatusSchema,
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  items_total: z.number().int().nullable(),
  items_succeeded: z.number().int().nullable(),
  items_failed: z.number().int().nullable(),
  created_at: z.string(),
});

export type SchedulerStageRun = z.infer<typeof schedulerStageRunSchema>;
