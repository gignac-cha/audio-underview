import { describe, expect, it } from 'vitest';
import {
  createSchedulerBodySchema,
  reorderSchedulerStagesBodySchema,
  updateSchedulerBodySchema,
  updateSchedulerStageBodySchema,
} from '../sources/schedulers/requests.ts';

const uuid = (suffix: string): string => `00000000-0000-4000-8000-00000000000${suffix}`;

describe('createSchedulerBodySchema', () => {
  it('accepts name only', () => {
    expect(createSchedulerBodySchema.safeParse({ name: 'Daily' }).success).toBe(true);
  });

  it('accepts a valid cron expression', () => {
    expect(
      createSchedulerBodySchema.safeParse({ name: 'Daily', cron_expression: '0 9 * * *' }).success,
    ).toBe(true);
  });

  it('rejects an invalid cron expression', () => {
    expect(
      createSchedulerBodySchema.safeParse({ name: 'Daily', cron_expression: 'often' }).success,
    ).toBe(false);
  });
});

describe('updateSchedulerBodySchema', () => {
  it('rejects an empty update', () => {
    expect(updateSchedulerBodySchema.safeParse({}).success).toBe(false);
  });

  it('accepts cron_expression: null (해제)', () => {
    expect(updateSchedulerBodySchema.safeParse({ cron_expression: null }).success).toBe(true);
  });
});

describe('updateSchedulerStageBodySchema', () => {
  it('rejects an empty update', () => {
    expect(updateSchedulerStageBodySchema.safeParse({}).success).toBe(false);
  });

  it('accepts fan_out_field: null (해제)', () => {
    expect(updateSchedulerStageBodySchema.safeParse({ fan_out_field: null }).success).toBe(true);
  });
});

describe('reorderSchedulerStagesBodySchema', () => {
  it('accepts unique UUIDs', () => {
    expect(
      reorderSchedulerStagesBodySchema.safeParse({ stage_ids: [uuid('1'), uuid('2')] }).success,
    ).toBe(true);
  });

  it('rejects an empty array', () => {
    expect(reorderSchedulerStagesBodySchema.safeParse({ stage_ids: [] }).success).toBe(false);
  });

  it('rejects duplicates', () => {
    expect(
      reorderSchedulerStagesBodySchema.safeParse({ stage_ids: [uuid('1'), uuid('1')] }).success,
    ).toBe(false);
  });

  it('rejects non-UUID elements', () => {
    expect(
      reorderSchedulerStagesBodySchema.safeParse({ stage_ids: ['first'] }).success,
    ).toBe(false);
  });
});
