import {
  createSchedulerStageRun,
  updateSchedulerStageRun,
  listSchedulerStageRunSummaries,
} from './scheduler-stage-runs.ts';
import { createMockClient } from './test-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// The logs a crawler stage run records (migration 013)

const logs = [
  { level: 'log' as const, message: 'first', timestamp: '2026-10-13T00:00:00.000Z' },
  { level: 'error' as const, message: 'second', timestamp: '2026-10-13T00:00:01.000Z', item_index: 2 },
];

describe('scheduler stage run logs', () => {
  test('updateSchedulerStageRun stores logs and logs_truncated', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: { id: 'stage-run-1', logs, logs_truncated: true }, error: null } });

    await updateSchedulerStageRun(client, 'stage-run-1', 'run-1', {
      status: 'completed',
      logs,
      logs_truncated: true,
    });

    const chain = client.from.mock.results[0].value;
    expect(chain.update).toHaveBeenCalledWith({ status: 'completed', logs, logs_truncated: true });
  });

  test('createSchedulerStageRun leaves logs to the database default', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: { id: 'stage-run-1' }, error: null } });
    const input = { run_id: 'run-1', stage_id: 'stage-1', stage_order: 0, status: 'running' as const };

    await createSchedulerStageRun(client, input);

    const chain = client.from.mock.results[0].value;
    expect(chain.insert).toHaveBeenCalledWith(input);
  });

  test('listSchedulerStageRunSummaries requests logs_truncated and not logs', async () => {
    const client = createMockClient({ scheduler_stage_runs: { data: [], error: null } });

    await listSchedulerStageRunSummaries(client, 'run-1');

    const chain = client.from.mock.results[0].value;
    const [columns] = chain.select.mock.calls[0];
    const requestedColumns = String(columns).split(',');
    expect(requestedColumns).toContain('logs_truncated');
    expect(requestedColumns).not.toContain('logs');
    expect(requestedColumns).not.toContain('input');
    expect(requestedColumns).not.toContain('output');
  });
});
