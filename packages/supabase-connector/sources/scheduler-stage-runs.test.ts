import { getSchedulerStageRun } from './scheduler-stage-runs.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleStageRun = {
  id: 'stage-run-1',
  run_id: 'run-1',
  stage_id: 'stage-1',
  stage_order: 0,
  status: 'completed',
  started_at: '2024-01-01T00:00:00Z',
  completed_at: '2024-01-01T00:00:01Z',
  input: { url: 'https://example.com' },
  output: { title: 'Example' },
  error: null,
  items_total: null,
  items_succeeded: null,
  items_failed: null,
  created_at: '2024-01-01T00:00:00Z',
};

describe('getSchedulerStageRun', () => {
  test('queries stage runs by ID and run', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: sampleStageRun, error: null } });

    await getSchedulerStageRun(client, 'stage-run-1', 'run-1');

    expect(client.from).toHaveBeenCalledWith('scheduler_stage_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['id', 'stage-run-1'],
      ['run_id', 'run-1'],
    ]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns stage run when found', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: sampleStageRun, error: null } });

    const result = await getSchedulerStageRun(client, 'stage-run-1', 'run-1');
    expect(result).toEqual(sampleStageRun);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: null, error: null } });

    const result = await getSchedulerStageRun(client, 'missing', 'run-1');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getSchedulerStageRun(client, 'stage-run-1', 'run-1')).rejects.toThrow(
      'Failed to get scheduler stage run: fail',
    );
  });
});
