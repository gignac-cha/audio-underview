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

export function resolveDefaultInput(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema === null || inputSchema === undefined || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error(`Invalid input_schema: expected object, got ${typeof inputSchema}`);
  }
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value !== null && value !== undefined && typeof value === 'object' && 'default' in value) {
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
    }).catch((updateError: unknown) => {
      logger.error('Failed to update stage run status after error', updateError, {
        function: 'executeStage',
        metadata: { stageRunID: stageRun.id, runID },
      });
    });

    throw error;
  }
}

const FAN_OUT_FAILED = Symbol('fan-out-failed');

export async function executeFanOut(
  dependencies: StageRunnerDependencies,
  stage: SchedulerStageRow,
  items: unknown[],
  concurrency: number = 1,
): Promise<FanOutResult> {
  const { crawlerExecutionClient, logger } = dependencies;

  const results: (unknown | typeof FAN_OUT_FAILED)[] = new Array(items.length).fill(FAN_OUT_FAILED);
  let itemsSucceeded = 0;
  let itemsFailed = 0;

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      try {
        const response = await crawlerExecutionClient.execute(stage.crawler_id, item);
        results[index] = response.result;
        itemsSucceeded++;
      } catch (error: unknown) {
        logger.warn('Fan-out item failed', error, {
          function: 'executeFanOut',
          metadata: { stageID: stage.id, itemIndex: index },
        });
        itemsFailed++;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);

  let status: 'completed' | 'partially_failed' | 'failed';
  if (itemsFailed === 0) {
    status = 'completed';
  } else if (itemsSucceeded > 0) {
    status = 'partially_failed';
  } else {
    status = 'failed';
  }

  const successfulResults = results.filter((result) => result !== FAN_OUT_FAILED);

  return {
    results: successfulResults,
    itemsTotal: items.length,
    itemsSucceeded,
    itemsFailed,
    status,
  };
}
