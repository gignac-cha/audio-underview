import {
  createSchedulerRun,
  getSchedulerRun,
  getSchedulerRunByID,
  getSchedulerRunByOccurrence,
  listActiveSchedulerRunsBefore,
  failSchedulerRuns,
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
  triggered_by: 'manual',
  scheduled_for: null,
  created_at: '2024-01-01T00:00:00Z',
};

const scheduledRun = {
  ...sampleRun,
  id: 'run-2',
  status: 'running',
  triggered_by: 'schedule',
  scheduled_for: '2026-10-05T22:00:00.000Z',
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

describe('getSchedulerRunByID', () => {
  test('queries runs by ID alone', async () => {
    const client = createMockClient({ scheduler_runs: { data: scheduledRun, error: null } });

    await getSchedulerRunByID(client, 'run-2');

    expect(client.from).toHaveBeenCalledWith('scheduler_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([['id', 'run-2']]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns run when found', async () => {
    const client = createMockClient({ scheduler_runs: { data: scheduledRun, error: null } });

    const result = await getSchedulerRunByID(client, 'run-2');
    expect(result).toEqual(scheduledRun);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ scheduler_runs: { data: null, error: null } });

    const result = await getSchedulerRunByID(client, 'missing');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getSchedulerRunByID(client, 'run-2')).rejects.toThrow('Failed to get scheduler run by ID: fail');
  });
});

describe('getSchedulerRunByOccurrence', () => {
  test('queries runs by scheduler and scheduled occurrence', async () => {
    const client = createMockClient({ scheduler_runs: { data: scheduledRun, error: null } });

    await getSchedulerRunByOccurrence(client, 'scheduler-1', '2026-10-05T22:00:00.000Z');

    expect(client.from).toHaveBeenCalledWith('scheduler_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['scheduler_id', 'scheduler-1'],
      ['scheduled_for', '2026-10-05T22:00:00.000Z'],
    ]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns run when found', async () => {
    const client = createMockClient({ scheduler_runs: { data: scheduledRun, error: null } });

    const result = await getSchedulerRunByOccurrence(client, 'scheduler-1', '2026-10-05T22:00:00.000Z');
    expect(result).toEqual(scheduledRun);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ scheduler_runs: { data: null, error: null } });

    const result = await getSchedulerRunByOccurrence(client, 'scheduler-1', '2026-10-05T22:00:00.000Z');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      getSchedulerRunByOccurrence(client, 'scheduler-1', '2026-10-05T22:00:00.000Z'),
    ).rejects.toThrow('Failed to get scheduler run by occurrence: fail');
  });
});

describe('listActiveSchedulerRunsBefore', () => {
  test('queries pending or running runs created before the given time, oldest first', async () => {
    const client = createMockClient({ scheduler_runs: { data: [scheduledRun], error: null } });

    await listActiveSchedulerRunsBefore(client, '2026-10-05T21:50:00.000Z', 200);

    expect(client.from).toHaveBeenCalledWith('scheduler_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.in).toHaveBeenCalledWith('status', ['pending', 'running']);
    expect(chain.lt).toHaveBeenCalledWith('created_at', '2026-10-05T21:50:00.000Z');
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  test('returns active runs', async () => {
    const client = createMockClient({ scheduler_runs: { data: [scheduledRun], error: null } });

    const result = await listActiveSchedulerRunsBefore(client, '2026-10-05T21:50:00.000Z', 200);
    expect(result).toEqual([scheduledRun]);
  });

  test('returns an empty array when none is found', async () => {
    const client = createMockClient({ scheduler_runs: { data: [], error: null } });

    const result = await listActiveSchedulerRunsBefore(client, '2026-10-05T21:50:00.000Z', 200);
    expect(result).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      listActiveSchedulerRunsBefore(client, '2026-10-05T21:50:00.000Z', 200),
    ).rejects.toThrow('Failed to list active scheduler runs: fail');
  });
});

describe('failSchedulerRuns', () => {
  test('sends every run in one fail_scheduler_runs call with the time and message', async () => {
    const client = createMockClient(
      {},
      { fail_scheduler_runs: { data: ['run-1', 'run-2'], error: null } },
    );

    await failSchedulerRuns(client, ['run-1', 'run-2'], '2026-10-05T22:00:00.000Z', 'Run was interrupted');

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('fail_scheduler_runs', {
      run_ids: ['run-1', 'run-2'],
      failed_at: '2026-10-05T22:00:00.000Z',
      failure_message: 'Run was interrupted',
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  test('returns the IDs of the runs that changed', async () => {
    const client = createMockClient(
      {},
      { fail_scheduler_runs: { data: ['run-2'], error: null } },
    );

    const result = await failSchedulerRuns(
      client,
      ['run-1', 'run-2'],
      '2026-10-05T22:00:00.000Z',
      'Run was interrupted',
    );
    expect(result).toEqual(['run-2']);
  });

  test('returns an empty array when no run changed', async () => {
    const client = createMockClient(
      {},
      { fail_scheduler_runs: { data: [], error: null } },
    );

    const result = await failSchedulerRuns(
      client,
      ['run-1'],
      '2026-10-05T22:00:00.000Z',
      'Run was interrupted',
    );
    expect(result).toEqual([]);
  });

  test('makes no request for an empty list', async () => {
    const client = createMockClient();

    const result = await failSchedulerRuns(client, [], '2026-10-05T22:00:00.000Z', 'Run was interrupted');

    expect(result).toEqual([]);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  test('throws on error', async () => {
    const client = createMockClient(
      {},
      { fail_scheduler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } } },
    );

    await expect(
      failSchedulerRuns(client, ['run-1'], '2026-10-05T22:00:00.000Z', 'Run was interrupted'),
    ).rejects.toThrow('Failed to mark scheduler runs as failed: fail');
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
