import type { Logger } from '@audio-underview/logger';
import { cronExpressionMatchesDate } from '@audio-underview/schemas';
import {
  ACTIVE_RUN_UNIQUE_INDEX,
  isUniqueViolation,
} from '@audio-underview/database-connector';
import { executeScheduler } from './scheduler-executor.ts';
import type { SchedulerManagerServices } from './services.ts';

const SCHEDULED_PIPELINE_TIMEOUT_MILLISECONDS = 300_000;

export interface ScheduledExecutionSummary {
  matched: number;
  started: number;
  skipped: number;
}

/**
 * cron 자동 실행 (신규 — 레거시는 cron_expression을 저장만 했다, 스펙 §4.9).
 *
 * 분 단위 tick마다 활성(is_enabled) + cron 보유 scheduler를 조회해
 * tick 시각과 매칭되는 것만 실행한다. 동시 실행 방지는 DB partial unique
 * index가 담당 — 이미 active run이 있으면 skip.
 */
export const executeDueSchedulers = async (
  services: SchedulerManagerServices,
  logger: Logger,
  tickDate: Date,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<ScheduledExecutionSummary> => {
  const candidates = await services.schedulers.listEnabledWithCron();
  const due = candidates.filter(
    (scheduler) =>
      scheduler.cron_expression !== null &&
      cronExpressionMatchesDate(scheduler.cron_expression, tickDate),
  );

  let started = 0;
  let skipped = 0;

  for (const scheduler of due) {
    try {
      const run = await services.runs.create({ scheduler_id: scheduler.id, status: 'pending' });
      started += 1;

      const abortController = new AbortController();
      const timer = setTimeout(() => {
        abortController.abort();
      }, SCHEDULED_PIPELINE_TIMEOUT_MILLISECONDS);

      waitUntil(
        executeScheduler(
          { services, logger },
          scheduler.id,
          scheduler.user_uuid,
          run.id,
          abortController.signal,
        )
          .then(async () => {
            clearTimeout(timer);
            if (abortController.signal.aborted) {
              await services.runs.update(
                run.id,
                scheduler.id,
                {
                  status: 'failed',
                  completed_at: new Date().toISOString(),
                  error: 'Pipeline execution timed out after 5 minutes',
                },
                { onlyIfStatus: ['pending', 'running'] },
              );
            }
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            logger.error('Scheduled execution failed', error, {
              function: 'executeDueSchedulers',
              metadata: { schedulerID: scheduler.id, runID: run.id },
            });
          }),
      );
    } catch (error) {
      if (isUniqueViolation(error, ACTIVE_RUN_UNIQUE_INDEX)) {
        skipped += 1; // 이미 실행 중 — 정상 상황
        continue;
      }
      logger.error('Failed to create scheduled run', error, {
        function: 'executeDueSchedulers',
        metadata: { schedulerID: scheduler.id },
      });
    }
  }

  return { matched: due.length, started, skipped };
};
