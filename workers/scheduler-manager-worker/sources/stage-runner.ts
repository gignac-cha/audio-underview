import type { SupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import type {
  SchedulerStageRow,
  SchedulerStageRunRow,
} from '@audio-underview/supabase-connector';
import {
  createSchedulerStageRun,
  updateSchedulerStageRun,
} from '@audio-underview/supabase-connector';
import type { CrawlerExecutionClient } from './crawler-execution-client.ts';

export interface StageRunnerDependencies {
  supabaseClient: SupabaseClient;
  crawlerExecutionClient: CrawlerExecutionClient;
  logger: Logger;
}

export interface StageResult {
  output: unknown;
  stageRun: SchedulerStageRunRow;
}

export interface FanOutResult {
  results: unknown[];
  itemsTotal: number;
  itemsSucceeded: number;
  itemsFailed: number;
  status: 'completed' | 'partially_failed' | 'failed';
}

export function resolveDefaultInput(inputSchema: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value != null && typeof value === 'object' && 'default' in value) {
      defaults[key] = (value as Record<string, unknown>).default;
    }
  }
  return defaults;
}

export async function executeStage(
  dependencies: StageRunnerDependencies,
  runID: string,
  stage: SchedulerStageRow,
  input: unknown,
): Promise<StageResult> {
  const { supabaseClient, crawlerExecutionClient, logger } = dependencies;

  const stageRun = await createSchedulerStageRun(supabaseClient, {
    run_id: runID,
    stage_id: stage.id,
    stage_order: stage.stage_order,
    status: 'running',
    started_at: new Date().toISOString(),
    input,
  });

  try {
    const response = await crawlerExecutionClient.execute(stage.crawler_id, input);

    const updatedStageRun = await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      output: response.result,
    });

    return { output: response.result, stageRun: updatedStageRun ?? stageRun };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Stage execution failed', error, {
      function: 'executeStage',
      metadata: { stageID: stage.id, stageOrder: stage.stage_order },
    });

    await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: errorMessage,
    });

    throw error;
  }
}

export async function executeFanOut(
  dependencies: StageRunnerDependencies,
  stage: SchedulerStageRow,
  items: unknown[],
): Promise<FanOutResult> {
  const { crawlerExecutionClient, logger } = dependencies;

  const results: unknown[] = [];
  let itemsSucceeded = 0;
  let itemsFailed = 0;

  for (const item of items) {
    try {
      const response = await crawlerExecutionClient.execute(stage.crawler_id, item);
      results.push(response.result);
      itemsSucceeded++;
    } catch (error: unknown) {
      logger.warn('Fan-out item failed', error, {
        function: 'executeFanOut',
        metadata: { stageID: stage.id },
      });
      itemsFailed++;
    }
  }

  let status: 'completed' | 'partially_failed' | 'failed';
  if (itemsFailed === 0) {
    status = 'completed';
  } else if (itemsSucceeded > 0) {
    status = 'partially_failed';
  } else {
    status = 'failed';
  }

  return {
    results,
    itemsTotal: items.length,
    itemsSucceeded,
    itemsFailed,
    status,
  };
}
