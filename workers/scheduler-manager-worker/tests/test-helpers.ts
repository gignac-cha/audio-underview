import { Logger } from '@audio-underview/logger';
import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';
import { signJWT } from '@audio-underview/worker-foundation';
import type {
  SchedulerRow,
  SchedulerRunRow,
  SchedulerStageRow,
  SchedulerStageRunRow,
} from '@audio-underview/database-connector';
import type { WorkerEnvironment } from '../sources/environment.ts';
import type { SchedulerManagerServices } from '../sources/services.ts';

export const JWT_SECRET = 'test-jwt-secret';
export const USER_UUID = '00000000-0000-4000-8000-000000000009';
export const SCHEDULER_ID = '00000000-0000-4000-8000-000000000001';
export const STAGE_ID = '00000000-0000-4000-8000-000000000002';
export const CRAWLER_ID = '00000000-0000-4000-8000-000000000003';
export const RUN_ID = '00000000-0000-4000-8000-000000000004';

export const silentLogger = new Logger({ transports: [] });

export const environment: WorkerEnvironment = {
  ALLOWED_ORIGINS: 'https://app.example.com',
  JWT_SECRET,
};

export const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

export const createBearerToken = (): Promise<string> =>
  signJWT(
    {
      sub: USER_UUID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    },
    JWT_SECRET,
  );

export const mockScheduler: SchedulerRow = {
  id: SCHEDULER_ID,
  user_uuid: USER_UUID,
  name: 'Daily Pipeline',
  cron_expression: null,
  is_enabled: true,
  last_run_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

export const mockStage: SchedulerStageRow = {
  id: STAGE_ID,
  scheduler_id: SCHEDULER_ID,
  crawler_id: CRAWLER_ID,
  stage_order: 0,
  input_schema: { url: { type: 'string', default: 'https://example.com' } },
  output_schema: {},
  fan_out_field: null,
  fan_out_strategy: 'compact',
  created_at: '2026-01-01T00:00:00Z',
};

export const mockRun: SchedulerRunRow = {
  id: RUN_ID,
  scheduler_id: SCHEDULER_ID,
  status: 'pending',
  started_at: null,
  completed_at: null,
  result: null,
  error: null,
  created_at: '2026-01-01T00:00:00Z',
};

export const mockStageRun: SchedulerStageRunRow = {
  id: '00000000-0000-4000-8000-000000000005',
  run_id: RUN_ID,
  stage_id: STAGE_ID,
  stage_order: 0,
  status: 'running',
  started_at: '2026-01-01T00:00:00Z',
  completed_at: null,
  input: null,
  output: null,
  error: null,
  items_total: null,
  items_succeeded: null,
  items_failed: null,
  created_at: '2026-01-01T00:00:00Z',
};

type DeepPartialServices = {
  [Group in keyof SchedulerManagerServices]?: Partial<SchedulerManagerServices[Group]>;
};

/** 전 메서드 "미구현 throw" 기본 fake — 필요한 것만 덮어쓴다. */
export const createFakeServices = (
  overrides: DeepPartialServices = {},
): SchedulerManagerServices => {
  const unimplemented = (name: string) => () => {
    throw new Error(`fake not implemented: ${name}`);
  };
  return {
    schedulers: {
      create: unimplemented('schedulers.create'),
      list: unimplemented('schedulers.list'),
      get: unimplemented('schedulers.get'),
      update: unimplemented('schedulers.update'),
      delete: unimplemented('schedulers.delete'),
      listEnabledWithCron: unimplemented('schedulers.listEnabledWithCron'),
      ...overrides.schedulers,
    },
    stages: {
      create: unimplemented('stages.create'),
      list: unimplemented('stages.list'),
      get: unimplemented('stages.get'),
      update: unimplemented('stages.update'),
      delete: unimplemented('stages.delete'),
      reorder: unimplemented('stages.reorder'),
      ...overrides.stages,
    },
    runs: {
      create: unimplemented('runs.create'),
      get: unimplemented('runs.get'),
      update: unimplemented('runs.update'),
      list: unimplemented('runs.list'),
      ...overrides.runs,
    },
    stageRuns: {
      create: unimplemented('stageRuns.create'),
      update: unimplemented('stageRuns.update'),
      ...overrides.stageRuns,
    },
    crawlerPermissions: {
      get: unimplemented('crawlerPermissions.get'),
      ...overrides.crawlerPermissions,
    },
    crawlerExecution: overrides.crawlerExecution?.execute
      ? { execute: overrides.crawlerExecution.execute }
      : { execute: unimplemented('crawlerExecution.execute') },
  };
};

/**
 * run/stage-run 기록을 in-memory로 추적하는 executor용 fake.
 */
export const createExecutorHarness = (stages: SchedulerStageRow[]) => {
  const runUpdates: Record<string, unknown>[] = [];
  const stageRunWrites: Record<string, unknown>[] = [];
  const schedulerUpdates: Record<string, unknown>[] = [];
  const executions: { crawlerID: string; input: unknown }[] = [];
  let executeImplementation: (crawlerID: string, input: unknown) => Promise<unknown> = (
    _crawlerID,
    input,
  ) => Promise.resolve({ type: 'data', result: input });

  const services = createFakeServices({
    stages: { list: () => Promise.resolve(stages) },
    runs: {
      update: (_id, _schedulerID, input) => {
        runUpdates.push(input as Record<string, unknown>);
        return Promise.resolve({ ...mockRun, ...(input as object) });
      },
    },
    stageRuns: {
      create: (input) => {
        stageRunWrites.push({ operation: 'create', ...(input as object) });
        return Promise.resolve({ ...mockStageRun, ...(input as object) });
      },
      update: (_id, _runID, input) => {
        stageRunWrites.push({ operation: 'update', ...(input as object) });
        return Promise.resolve({ ...mockStageRun, ...(input as object) });
      },
    },
    schedulers: {
      update: (_id, _user, input) => {
        schedulerUpdates.push(input as Record<string, unknown>);
        return Promise.resolve(mockScheduler);
      },
    },
    crawlerExecution: {
      execute: (crawlerID, input) => {
        executions.push({ crawlerID, input });
        return executeImplementation(crawlerID, input).then(
          (result) => result as { type: 'web' | 'data'; result?: unknown },
        );
      },
    },
  });

  return {
    services,
    runUpdates,
    stageRunWrites,
    schedulerUpdates,
    executions,
    setExecuteImplementation: (
      implementation: (crawlerID: string, input: unknown) => Promise<unknown>,
    ) => {
      executeImplementation = implementation;
    },
  };
};
