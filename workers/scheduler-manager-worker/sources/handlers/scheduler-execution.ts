import {
  ACTIVE_RUN_UNIQUE_INDEX,
  isUniqueViolation,
  type SchedulerRunRow,
} from '@audio-underview/database-connector';
import type { SchedulerRunStatus } from '@audio-underview/schemas';
import {
  errorResponse,
  jsonResponse,
  type RequestContext,
} from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from '../environment.ts';
import { executeScheduler } from '../scheduler-executor.ts';
import type { SchedulerManagerServices } from '../services.ts';

export const PIPELINE_TIMEOUT_MILLISECONDS = 300_000; // 5분

/**
 * run 상태/에러 메시지 → HTTP status (스펙 §4.5 — 테스트로 고정된 매핑).
 * error 문자열은 DB에 영속된 값이므로 문자열 매칭이 계약의 일부다.
 */
export const resolveHTTPStatus = (status: SchedulerRunStatus, error: string | null): number => {
  if (status !== 'failed' || error === null) {
    return 200;
  }
  if (error.includes('timed out')) {
    return 408;
  }
  if (error.includes('Invalid input_schema') || error.includes('fan_out_field')) {
    return 422;
  }
  if (error.includes('CodeRunner error') || error.includes('Invalid CrawlerExecuteResult')) {
    return 502;
  }
  if (error.includes('Supabase') || error.includes('database')) {
    return 503;
  }
  return 500;
};

const toExecuteResponse = (run: SchedulerRunRow): Record<string, unknown> => ({
  run_id: run.id,
  status: run.status,
  result: run.result ?? null,
  error: run.error,
  started_at: run.started_at,
  completed_at: run.completed_at,
});

export interface ExecutionHandlerOptions {
  /** 테스트 주입용 — 기본 5분 */
  pipelineTimeoutMilliseconds?: number;
}

/** `POST /schedulers/:schedulerID/execute` — 동기 실행 (스펙 §4.5) */
export const handleExecuteScheduler = async (
  context: RequestContext<WorkerEnvironment>,
  services: SchedulerManagerServices,
  options: ExecutionHandlerOptions = {},
): Promise<Response> => {
  const schedulerID = context.parameters.schedulerID ?? '';
  const userUUID = context.userUUID ?? '';
  const timeout = options.pipelineTimeoutMilliseconds ?? PIPELINE_TIMEOUT_MILLISECONDS;

  const scheduler = await services.schedulers.get(schedulerID, userUUID);
  if (scheduler === undefined) {
    return errorResponse('not_found', 'Scheduler not found', 404, context.responseContext);
  }

  let run: SchedulerRunRow;
  try {
    run = await services.runs.create({ scheduler_id: schedulerID, status: 'pending' });
  } catch (error) {
    // scheduler당 active run 1개 제약 (partial unique index — 스펙 §4.5.2)
    if (isUniqueViolation(error, ACTIVE_RUN_UNIQUE_INDEX)) {
      return errorResponse('conflict', 'A run is already in progress', 409, context.responseContext);
    }
    throw error;
  }

  const abortController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeout);
  });

  const raceResult = await Promise.race([
    executeScheduler(
      { services, logger: context.logger },
      schedulerID,
      userUUID,
      run.id,
      abortController.signal,
    ).then(() => 'completed' as const),
    timeoutPromise,
  ]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  if (raceResult === 'timeout') {
    abortController.abort();
    // executor가 이미 종료 상태를 썼다면 덮어쓰지 않는다 (onlyIfStatus guard)
    await services.runs.update(
      run.id,
      schedulerID,
      {
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: 'Pipeline execution timed out after 5 minutes',
      },
      { onlyIfStatus: ['pending', 'running'] },
    );
  }

  const finalRun = (await services.runs.get(run.id, schedulerID)) ?? run;
  return jsonResponse(
    toExecuteResponse(finalRun),
    resolveHTTPStatus(finalRun.status, finalRun.error),
    context.responseContext,
  );
};
