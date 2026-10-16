import { createCrawlerRun, getCrawlerRunForUser } from './crawler-runs.ts';
import { createMockClient } from './test-helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const USER_UUID = '00000000-0000-0000-0000-000000000001';
const CRAWLER_ID = '00000000-0000-0000-0000-0000000000c1';
const RUN_ID = '00000000-0000-0000-0000-0000000000a1';

const sampleRun = {
  id: RUN_ID,
  user_uuid: USER_UUID,
  crawler_id: CRAWLER_ID,
  status: 'failed',
  result: null,
  error_code: 'execution_failed',
  error: 'CodeRunner error 422: [execution_failed] boom',
  logs: [{ level: 'log', message: 'started', timestamp: '2026-10-13T00:00:00.000Z' }],
  logs_truncated: false,
  started_at: '2026-10-13T00:00:00.000Z',
  completed_at: '2026-10-13T00:00:01.000Z',
  created_at: '2026-10-13T00:00:01.000Z',
};

describe('createCrawlerRun', () => {
  test('inserts the run and returns it', async () => {
    const client = createMockClient({ crawler_runs: { data: sampleRun, error: null } });
    const input = {
      user_uuid: USER_UUID,
      crawler_id: CRAWLER_ID,
      status: 'failed' as const,
      result: null,
      error_code: 'execution_failed',
      error: 'CodeRunner error 422: [execution_failed] boom',
      logs: [{ level: 'log' as const, message: 'started', timestamp: '2026-10-13T00:00:00.000Z' }],
      logs_truncated: false,
      started_at: '2026-10-13T00:00:00.000Z',
      completed_at: '2026-10-13T00:00:01.000Z',
    };

    await expect(createCrawlerRun(client, input)).resolves.toEqual(sampleRun);

    expect(client.from).toHaveBeenCalledWith('crawler_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.insert).toHaveBeenCalledWith(input);
    expect(chain.single).toHaveBeenCalled();
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(createCrawlerRun(client, {
      user_uuid: USER_UUID,
      crawler_id: CRAWLER_ID,
      status: 'completed',
      started_at: '2026-10-13T00:00:00.000Z',
      completed_at: '2026-10-13T00:00:01.000Z',
    })).rejects.toThrow('Failed to create crawler run: fail');
  });
});

describe('getCrawlerRunForUser', () => {
  test('queries the run by ID, crawler and user', async () => {
    const client = createMockClient({ crawler_runs: { data: sampleRun, error: null } });

    await getCrawlerRunForUser(client, RUN_ID, CRAWLER_ID, USER_UUID);

    expect(client.from).toHaveBeenCalledWith('crawler_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['id', RUN_ID],
      ['crawler_id', CRAWLER_ID],
      ['user_uuid', USER_UUID],
    ]);
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('returns the run when found', async () => {
    const client = createMockClient({ crawler_runs: { data: sampleRun, error: null } });

    await expect(getCrawlerRunForUser(client, RUN_ID, CRAWLER_ID, USER_UUID)).resolves.toEqual(sampleRun);
  });

  test('returns undefined when not found', async () => {
    const client = createMockClient({ crawler_runs: { data: null, error: null } });

    await expect(getCrawlerRunForUser(client, RUN_ID, CRAWLER_ID, USER_UUID)).resolves.toBeUndefined();
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(getCrawlerRunForUser(client, RUN_ID, CRAWLER_ID, USER_UUID)).rejects.toThrow(
      'Failed to get crawler run: fail',
    );
  });
});
