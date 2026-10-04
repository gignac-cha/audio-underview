import {
  createScheduler,
  listSchedulersByUser,
  getScheduler,
  getSchedulerByID,
  listSchedulersDue,
  listSchedulersWithoutNextRun,
  setSchedulerNextRuns,
  updateScheduler,
  deleteScheduler,
} from './schedulers.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleScheduler = {
  id: 'scheduler-1',
  user_uuid: 'uuid-1',
  name: 'Test Scheduler',
  cron_expression: null,
  is_enabled: true,
  last_run_at: null,
  timezone: 'Asia/Seoul',
  next_run_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const scheduledScheduler = {
  ...sampleScheduler,
  cron_expression: '0 7 * * *',
  next_run_at: '2026-10-05T22:00:00.000Z',
};

describe('createScheduler', () => {
  test('returns created scheduler', async () => {
    const client = createMockClient({ schedulers: { data: sampleScheduler, error: null } });

    const result = await createScheduler(client, { user_uuid: 'uuid-1', name: 'Test Scheduler' });
    expect(result).toEqual(sampleScheduler);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      createScheduler(client, { user_uuid: 'uuid-1', name: 's' }),
    ).rejects.toThrow('Failed to create scheduler');
  });
});

describe('listSchedulersByUser', () => {
  test('returns paginated schedulers', async () => {
    const schedulers = [sampleScheduler];
    const client = createMockClient({ schedulers: { data: schedulers, error: null, count: 1 } });

    const result = await listSchedulersByUser(client, 'uuid-1');
    expect(result.data).toEqual(schedulers);
    expect(result.total).toBe(1);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listSchedulersByUser(client, 'uuid-1')).rejects.toThrow('Failed to list schedulers');
  });
});

describe('getScheduler', () => {
  test('returns scheduler when found', async () => {
    const client = createMockClient({ schedulers: { data: sampleScheduler, error: null } });

    const result = await getScheduler(client, 'scheduler-1', 'uuid-1');
    expect(result).toEqual(sampleScheduler);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await getScheduler(client, 'scheduler-1', 'uuid-1');
    expect(result).toBeUndefined();
  });
});

describe('getSchedulerByID', () => {
  test('queries schedulers by ID with no user condition', async () => {
    const client = createMockClient({ schedulers: { data: sampleScheduler, error: null } });

    await getSchedulerByID(client, 'scheduler-1');

    expect(client.from).toHaveBeenCalledWith('schedulers');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([['id', 'scheduler-1']]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns scheduler when found', async () => {
    const client = createMockClient({ schedulers: { data: sampleScheduler, error: null } });

    const result = await getSchedulerByID(client, 'scheduler-1');
    expect(result).toEqual(sampleScheduler);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ schedulers: { data: null, error: null } });

    const result = await getSchedulerByID(client, 'missing');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getSchedulerByID(client, 'scheduler-1')).rejects.toThrow(
      'Failed to get scheduler by ID: fail',
    );
  });
});

describe('listSchedulersDue', () => {
  test('queries enabled schedulers with a cron expression due by now, earliest next run first', async () => {
    const client = createMockClient({ schedulers: { data: [scheduledScheduler], error: null } });

    await listSchedulersDue(client, '2026-10-05T22:00:00.000Z', 500);

    expect(client.from).toHaveBeenCalledWith('schedulers');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([['is_enabled', true]]);
    expect(chain.not).toHaveBeenCalledWith('cron_expression', 'is', null);
    expect(chain.lte).toHaveBeenCalledWith('next_run_at', '2026-10-05T22:00:00.000Z');
    expect(chain.order).toHaveBeenCalledWith('next_run_at', { ascending: true });
    expect(chain.limit).toHaveBeenCalledWith(500);
  });

  test('returns due schedulers', async () => {
    const client = createMockClient({ schedulers: { data: [scheduledScheduler], error: null } });

    const result = await listSchedulersDue(client, '2026-10-05T22:00:00.000Z', 500);
    expect(result).toEqual([scheduledScheduler]);
  });

  test('returns an empty array when none is due', async () => {
    const client = createMockClient({ schedulers: { data: [], error: null } });

    const result = await listSchedulersDue(client, '2026-10-05T22:00:00.000Z', 500);
    expect(result).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listSchedulersDue(client, '2026-10-05T22:00:00.000Z', 500)).rejects.toThrow(
      'Failed to list due schedulers: fail',
    );
  });
});

describe('listSchedulersWithoutNextRun', () => {
  const unscheduledScheduler = { ...scheduledScheduler, next_run_at: null };

  test('queries enabled schedulers with a cron expression and no next run, by created_at then id', async () => {
    const client = createMockClient({ schedulers: { data: [unscheduledScheduler], error: null } });

    await listSchedulersWithoutNextRun(client, 500);

    expect(client.from).toHaveBeenCalledWith('schedulers');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([['is_enabled', true]]);
    expect(chain.not).toHaveBeenCalledWith('cron_expression', 'is', null);
    expect(chain.is).toHaveBeenCalledWith('next_run_at', null);
    expect(chain.order.mock.calls).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    expect(chain.limit).toHaveBeenCalledWith(500);
  });

  test('without after, does not add a cursor condition', async () => {
    const client = createMockClient({ schedulers: { data: [unscheduledScheduler], error: null } });

    await listSchedulersWithoutNextRun(client, 500);

    const chain = client.from.mock.results[0].value;
    expect(chain.or).not.toHaveBeenCalled();
  });

  test('with after, reads only rows strictly after that created_at and id, quoting the timestamp', async () => {
    const client = createMockClient({ schedulers: { data: [unscheduledScheduler], error: null } });

    await listSchedulersWithoutNextRun(client, 500, {
      created_at: '2024-01-01T00:00:00.123456+00:00',
      id: 'scheduler-1',
    });

    const chain = client.from.mock.results[0].value;
    expect(chain.or).toHaveBeenCalledTimes(1);
    expect(chain.or).toHaveBeenCalledWith(
      'created_at.gt."2024-01-01T00:00:00.123456+00:00",'
        + 'and(created_at.eq."2024-01-01T00:00:00.123456+00:00",id.gt.scheduler-1)',
    );
    expect(chain.eq.mock.calls).toEqual([['is_enabled', true]]);
    expect(chain.is).toHaveBeenCalledWith('next_run_at', null);
    expect(chain.order.mock.calls).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
    expect(chain.limit).toHaveBeenCalledWith(500);
  });

  test('returns schedulers without a next run', async () => {
    const client = createMockClient({ schedulers: { data: [unscheduledScheduler], error: null } });

    const result = await listSchedulersWithoutNextRun(client, 500);
    expect(result).toEqual([unscheduledScheduler]);
  });

  test('returns an empty array when none is found', async () => {
    const client = createMockClient({ schedulers: { data: [], error: null } });

    const result = await listSchedulersWithoutNextRun(client, 500);
    expect(result).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listSchedulersWithoutNextRun(client, 500)).rejects.toThrow(
      'Failed to list schedulers without next run: fail',
    );
  });
});

describe('setSchedulerNextRuns', () => {
  const updates = [
    { id: 'scheduler-1', expected: null, next: '2026-10-05T22:00:00.000Z' },
    { id: 'scheduler-2', expected: '2026-10-05T22:00:00.000Z', next: '2026-10-06T22:00:00.000Z' },
    { id: 'scheduler-3', expected: '2026-10-05T22:00:00.000Z', next: null },
  ];

  test('sends every update in one set_scheduler_next_runs call, mapping expected and next to the column names', async () => {
    const client = createMockClient(
      {},
      { set_scheduler_next_runs: { data: ['scheduler-1', 'scheduler-2', 'scheduler-3'], error: null } },
    );

    await setSchedulerNextRuns(client, updates);

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('set_scheduler_next_runs', {
      updates: [
        { id: 'scheduler-1', expected_next_run_at: null, next_run_at: '2026-10-05T22:00:00.000Z' },
        {
          id: 'scheduler-2',
          expected_next_run_at: '2026-10-05T22:00:00.000Z',
          next_run_at: '2026-10-06T22:00:00.000Z',
        },
        { id: 'scheduler-3', expected_next_run_at: '2026-10-05T22:00:00.000Z', next_run_at: null },
      ],
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  test('returns the IDs of the schedulers that changed', async () => {
    const client = createMockClient(
      {},
      { set_scheduler_next_runs: { data: ['scheduler-2'], error: null } },
    );

    const result = await setSchedulerNextRuns(client, updates);
    expect(result).toEqual(['scheduler-2']);
  });

  test('returns an empty array when no scheduler changed', async () => {
    const client = createMockClient(
      {},
      { set_scheduler_next_runs: { data: [], error: null } },
    );

    const result = await setSchedulerNextRuns(client, updates);
    expect(result).toEqual([]);
  });

  test('makes no request for an empty list', async () => {
    const client = createMockClient();

    const result = await setSchedulerNextRuns(client, []);

    expect(result).toEqual([]);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  test('throws on error', async () => {
    const client = createMockClient(
      {},
      { set_scheduler_next_runs: { data: null, error: { code: 'OTHER', message: 'fail' } } },
    );

    await expect(setSchedulerNextRuns(client, updates)).rejects.toThrow(
      'Failed to set scheduler next runs: fail',
    );
  });
});

describe('updateScheduler', () => {
  test('returns updated scheduler', async () => {
    const updated = { ...sampleScheduler, name: 'Updated' };
    const client = createMockClient({ schedulers: { data: updated, error: null } });

    const result = await updateScheduler(client, 'scheduler-1', 'uuid-1', { name: 'Updated' });
    expect(result).toEqual(updated);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await updateScheduler(client, 'scheduler-1', 'uuid-1', { name: 'Updated' });
    expect(result).toBeUndefined();
  });
});

describe('deleteScheduler', () => {
  test('returns true when deleted', async () => {
    const client = createMockClient({ schedulers: { data: [sampleScheduler], error: null } });

    const result = await deleteScheduler(client, 'scheduler-1', 'uuid-1');
    expect(result).toBe(true);
  });

  test('returns false when not found', async () => {
    const client = createMockClient({ schedulers: { data: [], error: null } });

    const result = await deleteScheduler(client, 'scheduler-1', 'uuid-1');
    expect(result).toBe(false);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      schedulers: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(deleteScheduler(client, 'scheduler-1', 'uuid-1')).rejects.toThrow('Failed to delete scheduler');
  });
});
