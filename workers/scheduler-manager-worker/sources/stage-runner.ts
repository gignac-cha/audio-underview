import type { Logger } from '@audio-underview/logger';
import type { SchedulerRunStatus } from '@audio-underview/schemas';
import type { SchedulerStageRow, SchedulerStageRunRow } from '@audio-underview/database-connector';
import type { SchedulerManagerServices } from './services.ts';

/**
 * stage 실행 단위 (스펙 §4.7). 테스트로 고정된 행위 계약:
 * - stage_run은 running → completed/failed 순으로 기록
 * - 실패 시 failed 기록 후 rethrow (기록 실패는 로그만)
 * - fan-out은 순차 실행, 실패 item은 카운터로만 관측 (개별 stage_run 없음)
 * - `resolveDefaultInput`은 falsy default(null/false)도 보존
 */

export interface StageRunnerDependencies {
  services: SchedulerManagerServices;
  logger: Logger;
}

/** input_schema의 `{ key: { default: value } }` descriptor에서 기본 입력 수집. */
export const resolveDefaultInput = (
  inputSchema: unknown,
): Record<string, unknown> => {
  if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
    throw new Error(
      `Invalid input_schema: expected object, got ${inputSchema === null ? 'null' : typeof inputSchema}`,
    );
  }

  const defaults: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(inputSchema)) {
    if (typeof descriptor === 'object' && descriptor !== null && 'default' in descriptor) {
      defaults[key] = (descriptor as Record<string, unknown>).default;
    }
  }
  return defaults;
};

export interface StageExecutionResult {
  output: unknown;
  stageRun: SchedulerStageRunRow;
}

export const executeStage = async (
  dependencies: StageRunnerDependencies,
  runID: string,
  stage: SchedulerStageRow,
  input: unknown,
  signal?: AbortSignal,
): Promise<StageExecutionResult> => {
  if (signal?.aborted === true) {
    throw new Error('Stage execution aborted: pipeline timed out');
  }

  const { services, logger } = dependencies;
  const stageRun = await services.stageRuns.create({
    run_id: runID,
    stage_id: stage.id,
    stage_order: stage.stage_order,
    status: 'running',
    started_at: new Date().toISOString(),
    input,
  });

  try {
    const response = await services.crawlerExecution.execute(stage.crawler_id, input);
    const updated = await services.stageRuns.update(stageRun.id, runID, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      output: response.result ?? null,
    });
    return { output: response.result, stageRun: updated ?? stageRun };
  } catch (error) {
    try {
      await services.stageRuns.update(stageRun.id, runID, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (updateError) {
      logger.error('Failed to record stage failure', updateError, {
        function: 'executeStage',
        metadata: { stageRunID: stageRun.id },
      });
    }
    throw error;
  }
};

/** 실패 슬롯 표시용 sentinel — 성공 결과가 null이어도 구분된다. */
const FAN_OUT_FAILED = Symbol('fan-out-item-failed');

export interface FanOutResult {
  results: unknown[];
  itemsTotal: number;
  itemsSucceeded: number;
  itemsFailed: number;
  status: SchedulerRunStatus;
}

export const executeFanOut = async (
  dependencies: StageRunnerDependencies,
  stage: SchedulerStageRow,
  items: unknown[],
  signal?: AbortSignal,
): Promise<FanOutResult> => {
  const { services, logger } = dependencies;
  const slots: unknown[] = [];
  let itemsSucceeded = 0;
  let itemsFailed = 0;

  // 순차 실행 (concurrency 1 — 레거시 계약 유지)
  for (const item of items) {
    if (signal?.aborted === true) {
      throw new Error('Stage execution aborted: pipeline timed out');
    }
    try {
      const response = await services.crawlerExecution.execute(stage.crawler_id, item);
      slots.push(response.result ?? null);
      itemsSucceeded += 1;
    } catch (error) {
      logger.warn('Fan-out item failed', {
        stageID: stage.id,
        crawlerID: stage.crawler_id,
        error: error instanceof Error ? error.message : String(error),
      });
      slots.push(FAN_OUT_FAILED);
      itemsFailed += 1;
    }
  }

  const results =
    stage.fan_out_strategy === 'preserve'
      ? slots.map((slot) => (slot === FAN_OUT_FAILED ? null : slot))
      : slots.filter((slot) => slot !== FAN_OUT_FAILED);

  const status: SchedulerRunStatus =
    itemsFailed === 0 ? 'completed' : itemsSucceeded > 0 ? 'partially_failed' : 'failed';

  return { results, itemsTotal: items.length, itemsSucceeded, itemsFailed, status };
};
