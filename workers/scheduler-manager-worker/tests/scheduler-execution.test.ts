import { describe, expect, it } from 'vitest';
import { createSchedulerManagerRouter } from '../sources/application.ts';
import { resolveHTTPStatus } from '../sources/handlers/scheduler-execution.ts';
import type { SchedulerManagerServices } from '../sources/services.ts';
import {
  createBearerToken,
  createFakeServices,
  environment,
  executionContext,
  mockRun,
  mockScheduler,
  SCHEDULER_ID,
} from './test-helpers.ts';

describe('resolveHTTPStatus (스펙 §4.5 전체 매핑)', () => {
  it.each([
    ['completed', null, 200],
    ['partially_failed', null, 200],
    ['pending', null, 200],
    ['running', null, 200],
    ['failed', null, 200],
    ['failed', 'Pipeline execution timed out after 5 minutes', 408],
    ['failed', 'Invalid input_schema: expected object, got string', 422],
    ['failed', 'Stage 0: fan_out_field "items" not found in input', 422],
    ['failed', 'CodeRunner error 422: [execution_failed] boom', 502],
    ['failed', 'Invalid CrawlerExecuteResult: unexpected shape', 502],
    ['failed', 'Failed to list crawlers: Supabase timeout', 503],
    ['failed', 'database connection lost', 503],
    ['failed', 'something else entirely', 500],
  ] as const)('%s + %s → %i', (status, error, expected) => {
    expect(resolveHTTPStatus(status, error)).toBe(expected);
  });
});

describe('POST /schedulers/:schedulerID/execute', () => {
  const execute = async (services: SchedulerManagerServices): Promise<Response> => {
    const router = createSchedulerManagerRouter(() => services);
    return router.fetch(
      new Request(`https://worker.example.com/schedulers/${SCHEDULER_ID}/execute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await createBearerToken()}` },
      }),
      environment,
      executionContext,
    );
  };

  it('returns 404 for an unowned scheduler', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(undefined) },
    });
    const response = await execute(services);
    expect(response.status).toBe(404);
  });

  it('returns 409 when a run is already in progress', async () => {
    const services = createFakeServices({
      schedulers: { get: () => Promise.resolve(mockScheduler) },
      runs: {
        create: () =>
          Promise.reject(
            Object.assign(
              new Error(
                'duplicate key value violates unique constraint "scheduler_runs_one_active_per_scheduler"',
              ),
              { code: '23505' },
            ),
          ),
      },
    });
    const response = await execute(services);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'conflict',
      error_description: 'A run is already in progress',
    });
  });

  it('executes an empty pipeline and returns the final run (200)', async () => {
    const updates: Record<string, unknown>[] = [];
    const finalRun = {
      ...mockRun,
      status: 'completed' as const,
      completed_at: '2026-01-01T00:01:00Z',
    };
    const services = createFakeServices({
      schedulers: {
        get: () => Promise.resolve(mockScheduler),
        update: () => Promise.resolve(mockScheduler),
      },
      stages: { list: () => Promise.resolve([]) },
      runs: {
        create: () => Promise.resolve(mockRun),
        update: (_id, _schedulerID, input) => {
          updates.push(input);
          return Promise.resolve(finalRun);
        },
        get: () => Promise.resolve(finalRun),
      },
    });

    const response = await execute(services);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run_id: mockRun.id,
      status: 'completed',
      error: null,
    });
    expect(updates.some((update) => update.status === 'completed')).toBe(true);
  });

  it('maps a failed run with a CodeRunner error to 502', async () => {
    const failedRun = {
      ...mockRun,
      status: 'failed' as const,
      error: 'CodeRunner error 422: [execution_failed] user code threw',
    };
    const services = createFakeServices({
      schedulers: {
        get: () => Promise.resolve(mockScheduler),
        update: () => Promise.resolve(mockScheduler),
      },
      stages: {
        list: () =>
          Promise.resolve([
            {
              ...mockRun,
              id: '00000000-0000-4000-8000-00000000000b',
              scheduler_id: SCHEDULER_ID,
              crawler_id: '00000000-0000-4000-8000-000000000003',
              stage_order: 0,
              input_schema: {},
              output_schema: {},
              fan_out_field: null,
              fan_out_strategy: 'compact' as const,
              created_at: '2026-01-01T00:00:00Z',
              status: undefined,
            } as never,
          ]),
      },
      runs: {
        create: () => Promise.resolve(mockRun),
        update: () => Promise.resolve(failedRun),
        get: () => Promise.resolve(failedRun),
      },
      stageRuns: {
        create: () => Promise.reject(new Error('CodeRunner error 422: [execution_failed] user code threw')),
      },
    });

    const response = await execute(services);
    expect(response.status).toBe(502);
  });
});
