import { createWorkerLogger } from '@audio-underview/logger';
import { createSchedulerManagerRouter, SERVICE_NAME } from './application.ts';
import type { WorkerEnvironment } from './environment.ts';
import { executeDueSchedulers } from './scheduled.ts';
import { createServices } from './services.ts';

const router = createSchedulerManagerRouter(createServices);

export default {
  fetch(request: Request, environment: WorkerEnvironment, executionContext: ExecutionContext) {
    return router.fetch(request, environment, executionContext);
  },

  /**
   * cron 자동 실행 — `SCHEDULED_EXECUTION_ENABLED = "true"`일 때만 동작 (ADR-6).
   */
  async scheduled(
    controller: ScheduledController,
    environment: WorkerEnvironment,
    executionContext: ExecutionContext,
  ): Promise<void> {
    if (environment.SCHEDULED_EXECUTION_ENABLED !== 'true') {
      return;
    }

    const logger = createWorkerLogger({ defaultContext: { module: SERVICE_NAME } });
    try {
      const summary = await executeDueSchedulers(
        createServices(environment),
        logger,
        new Date(controller.scheduledTime),
        (promise) => executionContext.waitUntil(promise),
      );
      if (summary.matched > 0) {
        logger.info('Scheduled tick processed', summary, { function: 'scheduled' });
      }
    } finally {
      executionContext.waitUntil(logger.flush());
    }
  },
};
