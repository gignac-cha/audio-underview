import {
  createSchedulerStage,
  listSchedulerStages,
  getSchedulerStage,
  updateSchedulerStage,
  deleteSchedulerStage,
  reorderSchedulerStages,
} from './scheduler-stages.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleStage = {
  id: 'stage-1',
  scheduler_id: 'scheduler-1',
  crawler_id: 'crawler-1',
  stage_order: 0,
  input_schema: { url: { type: 'string', default: 'https://example.com' } },
  output_schema: {},
  fan_out_field: null,
  created_at: '2024-01-01T00:00:00Z',
};

describe('createSchedulerStage', () => {
  test('returns created stage', async () => {
    const client = createMockClient({ scheduler_stages: { data: sampleStage, error: null } });

    const result = await createSchedulerStage(client, {
      scheduler_id: 'scheduler-1',
      crawler_id: 'crawler-1',
      stage_order: 0,
      input_schema: { url: { type: 'string', default: 'https://example.com' } },
    });
    expect(result).toEqual(sampleStage);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stages: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      createSchedulerStage(client, {
        scheduler_id: 'scheduler-1',
        crawler_id: 'crawler-1',
        stage_order: 0,
        input_schema: {},
      }),
    ).rejects.toThrow('Failed to create scheduler stage');
  });
});

describe('listSchedulerStages', () => {
  test('returns stages sorted by order', async () => {
    const stages = [sampleStage];
    const client = createMockClient({ scheduler_stages: { data: stages, error: null } });

    const result = await listSchedulerStages(client, 'scheduler-1');
    expect(result).toEqual(stages);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stages: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listSchedulerStages(client, 'scheduler-1')).rejects.toThrow('Failed to list scheduler stages');
  });
});

describe('getSchedulerStage', () => {
  test('returns stage when found', async () => {
    const client = createMockClient({ scheduler_stages: { data: sampleStage, error: null } });

    const result = await getSchedulerStage(client, 'stage-1', 'scheduler-1');
    expect(result).toEqual(sampleStage);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      scheduler_stages: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await getSchedulerStage(client, 'stage-1', 'scheduler-1');
    expect(result).toBeNull();
  });
});

describe('updateSchedulerStage', () => {
  test('returns updated stage', async () => {
    const updated = { ...sampleStage, fan_out_field: 'urls' };
    const client = createMockClient({ scheduler_stages: { data: updated, error: null } });

    const result = await updateSchedulerStage(client, 'stage-1', 'scheduler-1', { fan_out_field: 'urls' });
    expect(result).toEqual(updated);
  });

  test('returns null on PGRST116', async () => {
    const client = createMockClient({
      scheduler_stages: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await updateSchedulerStage(client, 'stage-1', 'scheduler-1', { fan_out_field: 'urls' });
    expect(result).toBeNull();
  });
});

describe('deleteSchedulerStage', () => {
  test('returns true when deleted', async () => {
    const client = createMockClient({ scheduler_stages: { data: [sampleStage], error: null } });

    const result = await deleteSchedulerStage(client, 'stage-1', 'scheduler-1');
    expect(result).toBe(true);
  });

  test('returns false when not found', async () => {
    const client = createMockClient({ scheduler_stages: { data: [], error: null } });

    const result = await deleteSchedulerStage(client, 'stage-1', 'scheduler-1');
    expect(result).toBe(false);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stages: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(deleteSchedulerStage(client, 'stage-1', 'scheduler-1')).rejects.toThrow('Failed to delete scheduler stage');
  });
});

describe('reorderSchedulerStages', () => {
  test('returns reordered stages', async () => {
    const reorderedStages = [
      { ...sampleStage, id: 'stage-2', stage_order: 0 },
      { ...sampleStage, id: 'stage-1', stage_order: 1 },
    ];
    const client = createMockClient(
      {},
      { reorder_scheduler_stages: { data: reorderedStages, error: null } },
    );

    const result = await reorderSchedulerStages(client, 'scheduler-1', ['stage-2', 'stage-1']);
    expect(result).toEqual(reorderedStages);
    expect(client.rpc).toHaveBeenCalledWith('reorder_scheduler_stages', {
      p_scheduler_id: 'scheduler-1',
      p_stage_ids: ['stage-2', 'stage-1'],
    });
  });

  test('throws on error', async () => {
    const client = createMockClient(
      {},
      { reorder_scheduler_stages: { data: null, error: { code: 'OTHER', message: 'fail' } } },
    );

    await expect(
      reorderSchedulerStages(client, 'scheduler-1', ['stage-1']),
    ).rejects.toThrow('Failed to reorder scheduler stages');
  });
});
