import { deleteExpiredCrawlerFiles, listCrawlerFileDeletions } from './crawler-files.ts';
import { updateSchedulerStageRun } from './scheduler-stage-runs.ts';
import { createMockClient, setupTracerMock } from './test-helpers.ts';

setupTracerMock();

afterEach(() => {
  vi.restoreAllMocks();
});

// What the functions of migration 013 answer when the database gives back nothing, and what an update of a
// stage run answers with its logs: the cases beyond crawler-files.test.ts and scheduler-stage-run-logs.test.ts.

describe('deleteExpiredCrawlerFiles', () => {
  test('returns 0 when the function returns nothing', async () => {
    const client = createMockClient({}, { delete_expired_crawler_files: { data: null, error: null } });

    await expect(deleteExpiredCrawlerFiles(client, 500)).resolves.toBe(0);
  });
});

describe('listCrawlerFileDeletions', () => {
  test('returns an empty array when the database answers no rows at all', async () => {
    const client = createMockClient({ crawler_file_deletions: { data: null, error: null } });

    await expect(listCrawlerFileDeletions(client, 500)).resolves.toEqual([]);
  });
});

describe('updateSchedulerStageRun', () => {
  test('returns the stage run with the logs and whether they were truncated', async () => {
    const logs = [
      { level: 'log' as const, message: 'fetched 3 items', timestamp: '2026-10-13T00:00:00.000Z' },
      { level: 'error' as const, message: 'failed', timestamp: '2026-10-13T00:00:01.000Z', item_index: 2 },
    ];
    const stageRun = { id: 'stage-run-1', run_id: 'run-1', status: 'completed', logs, logs_truncated: true };
    const client = createMockClient({ scheduler_stage_runs: { data: stageRun, error: null } });

    const result = await updateSchedulerStageRun(client, 'stage-run-1', 'run-1', { status: 'completed', logs, logs_truncated: true });

    expect(result?.logs).toEqual(logs);
    expect(result?.logs_truncated).toBe(true);
  });
});
