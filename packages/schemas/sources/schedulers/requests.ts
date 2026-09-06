import { z } from 'zod';
import { MAXIMUM_CRON_EXPRESSION_LENGTH, MAXIMUM_NAME_LENGTH } from '../common/limits.ts';
import { plainObjectSchema } from '../common/json-objects.ts';
import { isValidCronExpression } from './cron.ts';
import { fanOutStrategySchema } from './entities.ts';

const nameSchema = z
  .string("Field 'name' is required and must be a non-empty string")
  .max(MAXIMUM_NAME_LENGTH, `Field 'name' must not exceed ${MAXIMUM_NAME_LENGTH} characters`)
  .refine((value) => value.trim().length > 0, {
    message: "Field 'name' is required and must be a non-empty string",
  });

const cronExpressionSchema = z
  .string("Field 'cron_expression' must be a string")
  .max(
    MAXIMUM_CRON_EXPRESSION_LENGTH,
    `Field 'cron_expression' must not exceed ${MAXIMUM_CRON_EXPRESSION_LENGTH} characters`,
  )
  .refine(isValidCronExpression, {
    message: "Field 'cron_expression' must be a valid cron expression",
  });

export const createSchedulerBodySchema = z.object({
  name: nameSchema,
  cron_expression: cronExpressionSchema.optional(),
  is_enabled: z.boolean("Field 'is_enabled' must be a boolean").optional(),
});

export type CreateSchedulerBody = z.infer<typeof createSchedulerBodySchema>;

/**
 * 부분 업데이트 — 모든 필드 optional이되 최소 1개 필수. `cron_expression: null`은 해제.
 */
export const updateSchedulerBodySchema = z
  .object({
    name: nameSchema.optional(),
    cron_expression: cronExpressionSchema.nullable().optional(),
    is_enabled: z.boolean("Field 'is_enabled' must be a boolean").optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.cron_expression !== undefined ||
      value.is_enabled !== undefined,
    { message: 'At least one field must be provided for update' },
  );

export type UpdateSchedulerBody = z.infer<typeof updateSchedulerBodySchema>;

const fanOutFieldSchema = z
  .string("Field 'fan_out_field' must be a non-empty string")
  .refine((value) => value.trim().length > 0, {
    message: "Field 'fan_out_field' must be a non-empty string",
  });

export const createSchedulerStageBodySchema = z.object({
  crawler_id: z.uuid("Field 'crawler_id' is required and must be a UUID"),
  stage_order: z
    .number("Field 'stage_order' is required and must be a non-negative integer")
    .int("Field 'stage_order' is required and must be a non-negative integer")
    .min(0, "Field 'stage_order' is required and must be a non-negative integer"),
  input_schema: plainObjectSchema,
  output_schema: plainObjectSchema.optional(),
  fan_out_field: fanOutFieldSchema.optional(),
  fan_out_strategy: fanOutStrategySchema.optional(),
});

export type CreateSchedulerStageBody = z.infer<typeof createSchedulerStageBodySchema>;

/**
 * 부분 업데이트 — 최소 1개 필드. `fan_out_field: null`은 fan-out 해제.
 * `crawler_id` 변경 시 permission 검사는 worker 계층에서 수행.
 */
export const updateSchedulerStageBodySchema = z
  .object({
    crawler_id: z.uuid("Field 'crawler_id' must be a UUID").optional(),
    stage_order: z
      .number("Field 'stage_order' must be a non-negative integer")
      .int("Field 'stage_order' must be a non-negative integer")
      .min(0, "Field 'stage_order' must be a non-negative integer")
      .optional(),
    input_schema: plainObjectSchema.optional(),
    output_schema: plainObjectSchema.optional(),
    fan_out_field: fanOutFieldSchema.nullable().optional(),
    fan_out_strategy: fanOutStrategySchema.optional(),
  })
  .refine(
    (value) =>
      value.crawler_id !== undefined ||
      value.stage_order !== undefined ||
      value.input_schema !== undefined ||
      value.output_schema !== undefined ||
      value.fan_out_field !== undefined ||
      value.fan_out_strategy !== undefined,
    { message: 'At least one field must be provided for update' },
  );

export type UpdateSchedulerStageBody = z.infer<typeof updateSchedulerStageBodySchema>;

/**
 * 전체 stage를 순서대로 모두 보내야 한다 (부분 reorder 불가 — RPC가 개수 일치를 강제).
 */
export const reorderSchedulerStagesBodySchema = z.object({
  stage_ids: z
    .array(z.uuid("Field 'stage_ids' must contain only UUIDs"), {
      error: "Field 'stage_ids' is required and must be a non-empty array",
    })
    .min(1, "Field 'stage_ids' is required and must be a non-empty array")
    .refine((values) => new Set(values).size === values.length, {
      message: "Field 'stage_ids' must not contain duplicates",
    }),
});

export type ReorderSchedulerStagesBody = z.infer<typeof reorderSchedulerStagesBodySchema>;
