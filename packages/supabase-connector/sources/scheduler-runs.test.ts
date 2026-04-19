import {
  createSchedulerRun,
  getSchedulerRun,
  updateSchedulerRun,
  listSchedulerRuns,
} from './scheduler-runs.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleRun = {
  id: 'run-1',
  scheduler_id: 'scheduler-1',
  status: 'pending',
  started_at: null,
  completed_at: null,
  result: null,
  error: null,
  created_at: '2024-01-01T00:00:00Z',
};

describe('createSchedulerRun', () => {
  test('returns created run', async () => {
    const client = createMockClient({ scheduler_runs: { data: sampleRun, error: null } });

    const result = await createSchedulerRun(client, { scheduler_id: 'scheduler-1' });
    expect(result).toEqual(sampleRun);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      createSchedulerRun(client, { scheduler_id: 'scheduler-1' }),
    ).rejects.toThrow('Failed to create scheduler run');
  });
});

describe('getSchedulerRun', () => {
  test('returns run when found', async () => {
    const client = createMockClient({ scheduler_runs: { data: sampleRun, error: null } });

    const result = await getSchedulerRun(client, 'run-1', 'scheduler-1');
    expect(result).toEqual(sampleRun);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await getSchedulerRun(client, 'run-1', 'scheduler-1');
    expect(result).toBeUndefined();
  });
});

describe('updateSchedulerRun', () => {
  test('returns updated run', async () => {
    const updated = { ...sampleRun, status: 'running' };
    const client = createMockClient({ scheduler_runs: { data: updated, error: null } });

    const result = await updateSchedulerRun(client, 'run-1', 'scheduler-1', { status: 'running' });
    expect(result).toEqual(updated);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await updateSchedulerRun(client, 'run-1', 'scheduler-1', { status: 'running' });
    expect(result).toBeUndefined();
  });
});

describe('listSchedulerRuns', () => {
  test('returns paginated runs', async () => {
    const runs = [sampleRun];
    const client = createMockClient({ scheduler_runs: { data: runs, error: null, count: 1 } });

    const result = await listSchedulerRuns(client, 'scheduler-1');
    expect(result.data).toEqual(runs);
    expect(result.total).toBe(1);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listSchedulerRuns(client, 'scheduler-1')).rejects.toThrow('Failed to list scheduler runs');
  });
});
