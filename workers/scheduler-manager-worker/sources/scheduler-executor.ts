import type { Logger } from '@audio-underview/logger';
import type { SchedulerStageRow } from '@audio-underview/database-connector';
import {
  executeFanOut,
  executeStage,
  resolveDefaultInput,
  type StageRunnerDependencies,
} from './stage-runner.ts';
import type { SchedulerManagerServices } from './services.ts';

/**
 * 파이프라인 실행 상태 머신 (스펙 §4.6).
 *
 * pending ─→ running ─┬─→ completed          (모든 stage 성공)
 *                     ├─→ partially_failed   (fan-out 일부 실패, 끝까지 진행)
 *                     └─→ failed             (stage throw / 전원 실패 / timeout)
 *
 * - 에러는 run에 기록하고 **rethrow하지 않는다** — 호출측은 run을 재조회해 응답.
 * - `signal.aborted` 이후에는 어떤 DB 쓰기도 하지 않는다 (timeout 경로가 기록 담당,
 *   `onlyIfStatus` guard와 이중 방어 — 스펙 §8.12).
 */

export interface SchedulerExecutorDependencies {
  services: SchedulerManagerServices;
  logger: Logger;
}

const runFanOutStage = async (
  dependencies: StageRunnerDependencies,
  runID: string,
  stage: SchedulerStageRow,
  fanOutField: string,
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<{ output: unknown[]; hasPartialFailure: boolean }> => {
  const { services } = dependencies;

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(
      `Stage ${stage.stage_order}: fan_out_field "${fanOutField}" requires object input, got ${
        input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input
      }`,
    );
  }
  const items = (input as Record<string, unknown>)[fanOutField];
  if (items === undefined || items === null) {
    throw new Error(`Stage ${stage.stage_order}: fan_out_field "${fanOutField}" not found in input`);
  }
  if (!Array.isArray(items)) {
    throw new Error(`Stage ${stage.stage_order}: fan_out_field "${fanOutField}" is not an array`);
  }

  const stageRun = await services.stageRuns.create({
    run_id: runID,
    stage_id: stage.id,
    stage_order: stage.stage_order,
    status: 'running',
    started_at: new Date().toISOString(),
    input,
  });

  if (items.length === 0) {
    await services.stageRuns.update(stageRun.id, runID, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      output: [],
      items_total: 0,
      items_succeeded: 0,
      items_failed: 0,
    });
    return { output: [], hasPartialFailure: false };
  }

  const fanOut = await executeFanOut(dependencies, stage, items, signal);
  await services.stageRuns.update(stageRun.id, runID, {
    status: fanOut.status,
    completed_at: new Date().toISOString(),
    output: fanOut.results,
    items_total: fanOut.itemsTotal,
    items_succeeded: fanOut.itemsSucceeded,
    items_failed: fanOut.itemsFailed,
  });

  if (fanOut.status === 'failed') {
    throw new Error(`Stage ${stage.stage_order}: all fan-out items failed`);
  }
  return { output: fanOut.results, hasPartialFailure: fanOut.status === 'partially_failed' };
};

export const executeScheduler = async (
  dependencies: SchedulerExecutorDependencies,
  schedulerID: string,
  userUUID: string,
  runID: string,
  signal?: AbortSignal,
): Promise<void> => {
  const { services, logger } = dependencies;
  const updateRun = async (
    input: Parameters<SchedulerManagerServices['runs']['update']>[2],
  ): Promise<void> => {
    if (signal?.aborted === true) {
      return; // timeout 경로가 기록 — late write 금지
    }
    try {
      await services.runs.update(runID, schedulerID, input, {
        onlyIfStatus: ['pending', 'running'],
      });
    } catch (error) {
      logger.error('Failed to update scheduler run', error, {
        function: 'executeScheduler',
        metadata: { runID },
      });
    }
  };

  try {
    await updateRun({ status: 'running', started_at: new Date().toISOString() });

    const stages = await services.stages.list(schedulerID);
    if (stages.length === 0) {
      await updateRun({
        status: 'completed',
        completed_at: new Date().toISOString(),
        result: null,
      });
      return;
    }

    const firstStage = stages[0] as SchedulerStageRow;
    let currentInput: unknown = resolveDefaultInput(firstStage.input_schema);
    let hasPartialFailure = false;

    for (const stage of stages) {
      if (signal?.aborted === true) {
        return;
      }

      if (stage.fan_out_field !== null) {
        const fanOut = await runFanOutStage(
          dependencies,
          runID,
          stage,
          stage.fan_out_field,
          currentInput,
          signal,
        );
        hasPartialFailure = hasPartialFailure || fanOut.hasPartialFailure;
        currentInput = fanOut.output;
      } else {
        const result = await executeStage(dependencies, runID, stage, currentInput, signal);
        currentInput = result.output; // stage N output === stage N+1 input
      }
    }

    if (signal?.aborted !== true) {
      await updateRun({
        status: hasPartialFailure ? 'partially_failed' : 'completed',
        completed_at: new Date().toISOString(),
        result: currentInput ?? null,
      });
    }
  } catch (error) {
    await updateRun({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // 성공/실패 무관 항상 갱신 — 단 abort 시에는 skip (스펙 §4.6.5)
    if (signal?.aborted !== true) {
      try {
        await services.schedulers.update(schedulerID, userUUID, {
          last_run_at: new Date().toISOString(),
        });
      } catch (error) {
        logger.error('Failed to update scheduler last_run_at', error, {
          function: 'executeScheduler',
          metadata: { schedulerID },
        });
      }
    }
  }
};
