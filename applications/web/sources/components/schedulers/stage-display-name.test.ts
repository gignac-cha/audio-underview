import { describe, test, expect } from 'vitest';
import type { CrawlerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import type { StageRunSummary } from '../../hooks/use-scheduler-runs.ts';
import { resolveStageDisplayName, resolveStageRunDisplayName } from './stage-display-name.ts';

const CRAWLER_ID = '00000000-0000-0000-0000-000000000030';

function createStage(overrides: Partial<SchedulerStageRow> = {}): SchedulerStageRow {
  return {
    id: 'stage-1',
    scheduler_id: 's1',
    stage_type: 'crawler',
    crawler_id: CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    input_schema: {},
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function createFormStage(): SchedulerStageRow {
  return createStage({ id: 'stage-form', stage_type: 'form', crawler_id: null, settings: { form: {} }, stage_order: 1 });
}

function createStageRun(overrides: Partial<StageRunSummary> = {}): StageRunSummary {
  return {
    id: 'stage-run-1',
    run_id: 'run-1',
    stage_id: 'stage-form',
    stage_order: 1,
    status: 'waiting',
    started_at: '2026-10-26T09:00:00.000Z',
    completed_at: null,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
    logs_truncated: false,
    created_at: '2026-10-26T09:00:00.000Z',
    ...overrides,
  };
}

const NO_CRAWLERS = new Map<string, CrawlerRow>();

describe('resolveStageDisplayName', () => {
  test('names a form stage Form', () => {
    expect(resolveStageDisplayName(createFormStage(), NO_CRAWLERS)).toBe('Form');
  });

  test('still names a crawler stage by its crawler', () => {
    expect(resolveStageDisplayName(createStage(), NO_CRAWLERS)).toBe('00000000...');
  });
});

describe('resolveStageRunDisplayName', () => {
  test('names the stage run of a form stage Form', () => {
    expect(resolveStageRunDisplayName(createStageRun(), [createStage(), createFormStage()], NO_CRAWLERS)).toBe('Form');
  });

  test('names the stage run of a form stage that was removed by its order', () => {
    expect(resolveStageRunDisplayName(createStageRun(), [createStage()], NO_CRAWLERS)).toBe('Stage 1');
  });
});
