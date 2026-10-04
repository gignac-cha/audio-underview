import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env, createScheduledController } from 'cloudflare:test';
import worker from '../sources/index.ts';
import type { Environment } from '../sources/index.ts';

// The tick and the module logger of the entry module are replaced with fakes,
// so the handler is tested without Supabase and without a real Workflow instance.
const fakes = vi.hoisted(() => ({
  runScheduleTick: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    createChild: vi.fn(),
  },
}));

vi.mock('../sources/schedule-tick.ts', () => ({ runScheduleTick: fakes.runScheduleTick }));

vi.mock('@audio-underview/logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@audio-underview/logger')>(),
  createWorkerLogger: () => fakes.logger,
}));

const SCHEDULED_TIME = new Date('2026-10-05T22:00:00.000Z');

function createFakeWorkflow() {
  return {
    create: vi.fn(),
    createBatch: vi.fn(),
    get: vi.fn(),
  };
}

function createEnvironment(workflow: ReturnType<typeof createFakeWorkflow>): Environment {
  return { ...env, SCHEDULER_RUN_WORKFLOW: workflow } as unknown as Environment;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('scheduled', () => {
  it('runs the tick at the scheduled time of the trigger and logs the result with info', async () => {
    const workflow = createFakeWorkflow();
    const result = { interrupted: 1, initialized: 2, started: 3 };
    fakes.runScheduleTick.mockResolvedValueOnce(result);

    const controller = createScheduledController({ scheduledTime: SCHEDULED_TIME, cron: '*/10 * * * *' });
    await worker.scheduled(controller, createEnvironment(workflow));

    expect(fakes.runScheduleTick).toHaveBeenCalledTimes(1);
    const [dependencies, now] = fakes.runScheduleTick.mock.calls[0];
    expect(now).toEqual(new Date(controller.scheduledTime));
    expect(now).toEqual(SCHEDULED_TIME);
    expect(dependencies.workflow).toBe(workflow);
    expect(dependencies.logger).toBe(fakes.logger);
    expect(dependencies.supabaseClient).toBeDefined();

    expect(fakes.logger.info).toHaveBeenCalledWith('Schedule tick finished', result, { function: 'scheduled' });
    expect(fakes.logger.error).not.toHaveBeenCalled();

    // The handler itself never touches the Workflow binding
    expect(workflow.create).not.toHaveBeenCalled();
    expect(workflow.createBatch).not.toHaveBeenCalled();
    expect(workflow.get).not.toHaveBeenCalled();
  });

  it('logs a tick error with error and rethrows it', async () => {
    const workflow = createFakeWorkflow();
    const tickError = new Error('tick failed');
    fakes.runScheduleTick.mockRejectedValueOnce(tickError);

    const controller = createScheduledController({ scheduledTime: SCHEDULED_TIME, cron: '*/10 * * * *' });
    await expect(worker.scheduled(controller, createEnvironment(workflow))).rejects.toBe(tickError);

    expect(fakes.runScheduleTick).toHaveBeenCalledTimes(1);
    expect(fakes.runScheduleTick.mock.calls[0][1]).toEqual(SCHEDULED_TIME);
    expect(fakes.logger.error).toHaveBeenCalledWith('Schedule tick failed', tickError, { function: 'scheduled' });
    expect(fakes.logger.info).not.toHaveBeenCalledWith('Schedule tick finished', expect.anything(), expect.anything());
  });
});
