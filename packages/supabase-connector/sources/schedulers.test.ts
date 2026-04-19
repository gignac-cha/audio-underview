import {
  createScheduler,
  listSchedulersByUser,
  getScheduler,
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
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
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
