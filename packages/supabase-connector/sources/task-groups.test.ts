import { listTaskGroups, getTaskGroup } from './task-groups.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleTaskGroup = {
  id: 'newscast',
  version: 1,
  input_schema: {},
  settings_schema: { type: 'object' },
  output_schema: {},
  worker_binding: 'NEWSCAST',
  created_at: '2026-10-04T00:00:00Z',
};

describe('listTaskGroups', () => {
  test('queries every task group by id and then version', async () => {
    const client = createMockClient({ task_groups: { data: [sampleTaskGroup], error: null } });

    await listTaskGroups(client);

    expect(client.from).toHaveBeenCalledWith('task_groups');
    const chain = client.from.mock.results[0].value;
    expect(chain.order.mock.calls).toEqual([
      ['id', { ascending: true }],
      ['version', { ascending: true }],
    ]);
    expect(chain.eq).not.toHaveBeenCalled();
  });

  test('returns the task groups', async () => {
    const taskGroups = [sampleTaskGroup, { ...sampleTaskGroup, version: 2 }];
    const client = createMockClient({ task_groups: { data: taskGroups, error: null } });

    const result = await listTaskGroups(client);
    expect(result).toEqual(taskGroups);
  });

  test('returns an empty array when no task group is registered', async () => {
    const client = createMockClient({ task_groups: { data: [], error: null } });

    const result = await listTaskGroups(client);
    expect(result).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      task_groups: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listTaskGroups(client)).rejects.toThrow('Failed to list task groups: fail');
  });
});

describe('getTaskGroup', () => {
  test('queries the task group by id and version', async () => {
    const client = createMockClient({ task_groups: { data: sampleTaskGroup, error: null } });

    await getTaskGroup(client, 'newscast', 1);

    expect(client.from).toHaveBeenCalledWith('task_groups');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['id', 'newscast'],
      ['version', 1],
    ]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns the task group when found', async () => {
    const client = createMockClient({ task_groups: { data: sampleTaskGroup, error: null } });

    const result = await getTaskGroup(client, 'newscast', 1);
    expect(result).toEqual(sampleTaskGroup);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ task_groups: { data: null, error: null } });

    const result = await getTaskGroup(client, 'newscast', 9);
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      task_groups: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getTaskGroup(client, 'newscast', 1)).rejects.toThrow('Failed to get task group: fail');
  });
});
