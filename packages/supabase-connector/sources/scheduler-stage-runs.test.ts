import {
  getSchedulerStageRun,
  getSchedulerStageRunByID,
  getSchedulerStageRunByStage,
  updateSchedulerStageRun,
  listSchedulerStageRunSummaries,
  setSchedulerStageRunProgress,
  failActiveSchedulerStageRuns,
} from './scheduler-stage-runs.ts';
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
  task_group_id: null,
  task_group_version: null,
  progress: null,
  created_at: '2024-01-01T00:00:00Z',
};

const taskGroupStageRun = {
  ...sampleStageRun,
  id: 'stage-run-2',
  status: 'running',
  completed_at: null,
  output: null,
  task_group_id: 'newscast',
  task_group_version: 1,
  progress: { message: 'Writing', completed: 1, total: 3, reported_at: '2024-01-01T00:00:02Z' },
};

const sampleProgress = { message: 'Writing', completed: 1, total: 3, reported_at: '2024-01-01T00:00:02Z' };

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

describe('getSchedulerStageRunByID', () => {
  test('queries stage runs by ID alone', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: taskGroupStageRun, error: null } });

    await getSchedulerStageRunByID(client, 'stage-run-2');

    expect(client.from).toHaveBeenCalledWith('scheduler_stage_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([['id', 'stage-run-2']]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns stage run when found', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: taskGroupStageRun, error: null } });

    const result = await getSchedulerStageRunByID(client, 'stage-run-2');
    expect(result).toEqual(taskGroupStageRun);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: null, error: null } });

    const result = await getSchedulerStageRunByID(client, 'missing');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getSchedulerStageRunByID(client, 'stage-run-2')).rejects.toThrow(
      'Failed to get scheduler stage run by ID: fail',
    );
  });
});

describe('getSchedulerStageRunByStage', () => {
  test('queries the stage run of the stage in the run, created last first, one row', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: taskGroupStageRun, error: null } });

    await getSchedulerStageRunByStage(client, 'run-1', 'stage-1');

    expect(client.from).toHaveBeenCalledWith('scheduler_stage_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['run_id', 'run-1'],
      ['stage_id', 'stage-1'],
    ]);
    expect(chain.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(1);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns stage run when found', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: taskGroupStageRun, error: null } });

    const result = await getSchedulerStageRunByStage(client, 'run-1', 'stage-1');
    expect(result).toEqual(taskGroupStageRun);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: null, error: null } });

    const result = await getSchedulerStageRunByStage(client, 'run-1', 'stage-1');
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(getSchedulerStageRunByStage(client, 'run-1', 'stage-1')).rejects.toThrow(
      'Failed to get scheduler stage run by stage: fail',
    );
  });
});

describe('updateSchedulerStageRun', () => {
  test('updates by ID and run without a status condition by default', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: sampleStageRun, error: null } });

    const result = await updateSchedulerStageRun(client, 'stage-run-1', 'run-1', { status: 'completed' });

    expect(result).toEqual(sampleStageRun);
    const chain = client.from.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({ status: 'completed' });
    expect(chain.eq.mock.calls).toEqual([
      ['id', 'stage-run-1'],
      ['run_id', 'run-1'],
    ]);
    expect(chain.in).not.toHaveBeenCalled();
    expect(chain.single).toHaveBeenCalled();
  });

  test('changes the stage run only while its status is one of onlyIfStatus', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: sampleStageRun, error: null } });

    await updateSchedulerStageRun(client, 'stage-run-1', 'run-1', { status: 'completed' }, { onlyIfStatus: ['running'] });

    const chain = client.from.mock.results[0].value;
    expect(chain.in).toHaveBeenCalledWith('status', ['running']);
  });

  test('returns undefined when no stage run matches the condition', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'PGRST116', message: 'not found' } },
    });

    const result = await updateSchedulerStageRun(
      client,
      'stage-run-1',
      'run-1',
      { status: 'completed' },
      { onlyIfStatus: ['running'] },
    );
    expect(result).toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      updateSchedulerStageRun(client, 'stage-run-1', 'run-1', { status: 'completed' }),
    ).rejects.toThrow('Failed to update scheduler stage run: fail');
  });
});

describe('listSchedulerStageRunSummaries', () => {
  const summary = (({ input: _input, output: _output, ...rest }) => rest)(taskGroupStageRun);

  test('queries the stage runs of the run by stage order without input and output', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [summary], error: null } });

    await listSchedulerStageRunSummaries(client, 'run-1');

    expect(client.from).toHaveBeenCalledWith('scheduler_stage_runs');
    const chain = client.from.mock.results[0].value;
    const [columns] = chain.select.mock.calls[0];
    const requestedColumns = String(columns).split(',');
    expect(requestedColumns).not.toContain('*');
    expect(requestedColumns).not.toContain('input');
    expect(requestedColumns).not.toContain('output');
    expect(requestedColumns).toEqual(expect.arrayContaining([
      'id', 'stage_order', 'status', 'error', 'task_group_id', 'task_group_version', 'progress',
    ]));
    expect(chain.eq.mock.calls).toEqual([['run_id', 'run-1']]);
    expect(chain.order).toHaveBeenCalledWith('stage_order', { ascending: true });
  });

  test('returns the summaries', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [summary], error: null } });

    const result = await listSchedulerStageRunSummaries(client, 'run-1');
    expect(result).toEqual([summary]);
  });

  test('returns an empty array when the run has no stage runs', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [], error: null } });

    const result = await listSchedulerStageRunSummaries(client, 'run-1');
    expect(result).toEqual([]);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(listSchedulerStageRunSummaries(client, 'run-1')).rejects.toThrow(
      'Failed to list scheduler stage run summaries: fail',
    );
  });
});

describe('setSchedulerStageRunProgress', () => {
  test('sets only the progress of the stage run while it is running', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [{ id: 'stage-run-2' }], error: null } });

    await setSchedulerStageRunProgress(client, 'stage-run-2', sampleProgress);

    expect(client.from).toHaveBeenCalledWith('scheduler_stage_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({ progress: sampleProgress });
    expect(chain.eq.mock.calls).toEqual([
      ['id', 'stage-run-2'],
      ['status', 'running'],
    ]);
  });

  test('never changes a crawler stage run, which has no task group', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [{ id: 'stage-run-2' }], error: null } });

    await setSchedulerStageRunProgress(client, 'stage-run-2', sampleProgress);

    const chain = client.from.mock.results[0].value;
    expect(chain.not).toHaveBeenCalledWith('task_group_id', 'is', null);
  });

  test('returns true when the stage run changed', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [{ id: 'stage-run-2' }], error: null } });

    const result = await setSchedulerStageRunProgress(client, 'stage-run-2', sampleProgress);
    expect(result).toBe(true);
  });

  test('returns false when no running stage run matched', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [], error: null } });

    const result = await setSchedulerStageRunProgress(client, 'stage-run-2', sampleProgress);
    expect(result).toBe(false);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(setSchedulerStageRunProgress(client, 'stage-run-2', sampleProgress)).rejects.toThrow(
      'Failed to set scheduler stage run progress: fail',
    );
  });
});

describe('failActiveSchedulerStageRuns', () => {
  test('fails the pending or running stage runs of the run with the time and message', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [{ id: 'stage-run-2' }], error: null } });

    await failActiveSchedulerStageRuns(client, 'run-1', '2026-10-05T22:00:00.000Z', 'Run ended before this stage finished');

    expect(client.from).toHaveBeenCalledWith('scheduler_stage_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({
      status: 'failed',
      completed_at: '2026-10-05T22:00:00.000Z',
      error: 'Run ended before this stage finished',
    });
    expect(chain.eq.mock.calls).toEqual([['run_id', 'run-1']]);
    expect(chain.in).toHaveBeenCalledWith('status', ['pending', 'running']);
    expect(chain.single).not.toHaveBeenCalled();
  });

  test('returns the number of stage runs changed', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: [{ id: 'stage-run-2' }, { id: 'stage-run-3' }], error: null },
    });

    const result = await failActiveSchedulerStageRuns(client, 'run-1', '2026-10-05T22:00:00.000Z', 'ended');
    expect(result).toBe(2);
  });

  test('returns 0 when no stage run changed', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [], error: null } });

    const result = await failActiveSchedulerStageRuns(client, 'run-1', '2026-10-05T22:00:00.000Z', 'ended');
    expect(result).toBe(0);
  });

  test('throws on error', async () => {
    const client = createMockClient({
      scheduler_stage_runs: { data: null, error: { code: 'OTHER', message: 'fail' } },
    });

    await expect(
      failActiveSchedulerStageRuns(client, 'run-1', '2026-10-05T22:00:00.000Z', 'ended'),
    ).rejects.toThrow('Failed to mark scheduler stage runs as failed: fail');
  });
});
