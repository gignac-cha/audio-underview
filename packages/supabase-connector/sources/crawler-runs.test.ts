import { createCrawlerRun, listCrawlerRunsForUser, getCrawlerRunForUser } from './crawler-runs.ts';
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
  kind: 'direct',
  type: 'data',
  code: null,
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
      kind: 'direct' as const,
      type: 'data' as const,
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

  test('inserts a test run of code without a crawler with its kind, type and code', async () => {
    const testRun = { ...sampleRun, crawler_id: null, kind: 'test', code: '(input) => input' };
    const client = createMockClient({ crawler_runs: { data: testRun, error: null } });
    const input = {
      user_uuid: USER_UUID,
      crawler_id: null,
      kind: 'test' as const,
      type: 'data' as const,
      code: '(input) => input',
      status: 'completed' as const,
      started_at: '2026-10-13T00:00:00.000Z',
      completed_at: '2026-10-13T00:00:01.000Z',
    };

    await expect(createCrawlerRun(client, input)).resolves.toEqual(testRun);

    const chain = client.from.mock.results[0].value;
    expect(chain.insert).toHaveBeenCalledWith(input);
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

describe('listCrawlerRunsForUser', () => {
  const summary = (({ result: _result, logs: _logs, code: _code, error: _error, user_uuid: _userUUID, ...rest }) => rest)(sampleRun);

  function requestedColumns(chain: { select: { mock: { calls: unknown[][] } } }): string[] {
    return String(chain.select.mock.calls[0][0]).split(',');
  }

  test('lists the runs of the user and the crawler, newest first, with the summary columns and an exact count', async () => {
    const client = createMockClient({ crawler_runs: { data: [summary], error: null, count: 1 } });

    await expect(listCrawlerRunsForUser(client, USER_UUID, { crawlerID: CRAWLER_ID })).resolves.toEqual({ data: [summary], total: 1 });

    expect(client.from).toHaveBeenCalledWith('crawler_runs');
    const chain = client.from.mock.results[0].value;
    expect(chain.select.mock.calls[0][1]).toEqual({ count: 'exact' });
    expect(chain.eq.mock.calls).toEqual([
      ['user_uuid', USER_UUID],
      ['crawler_id', CRAWLER_ID],
    ]);
    expect(chain.is).not.toHaveBeenCalled();
    expect(chain.order.mock.calls).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(chain.range).toHaveBeenCalledWith(0, 19);
  });

  test('selects the summary columns only: no result, logs or code', async () => {
    const client = createMockClient({ crawler_runs: { data: [], error: null, count: 0 } });

    await listCrawlerRunsForUser(client, USER_UUID, { crawlerID: CRAWLER_ID });

    const columns = requestedColumns(client.from.mock.results[0].value);
    expect(columns).toEqual([
      'id', 'crawler_id', 'kind', 'type', 'status', 'error_code', 'logs_truncated', 'started_at', 'completed_at', 'created_at',
    ]);
    for (const column of ['*', 'result', 'logs', 'code', 'error']) {
      expect(columns).not.toContain(column);
    }
  });

  test('filters crawler_id IS NULL for the test runs of code without a crawler', async () => {
    const client = createMockClient({ crawler_runs: { data: [], error: null, count: 0 } });

    await listCrawlerRunsForUser(client, USER_UUID, { crawlerID: null });

    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([['user_uuid', USER_UUID]]);
    expect(chain.is.mock.calls).toEqual([['crawler_id', null]]);
  });

  test('takes the offset and the limit, clamped to 0 and to 1 through 100', async () => {
    for (const [options, range] of [
      [{ offset: 40, limit: 20 }, [40, 59]],
      [{ offset: -5, limit: 0 }, [0, 0]],
      [{ offset: 0, limit: 500 }, [0, 99]],
    ] as const) {
      const client = createMockClient({ crawler_runs: { data: [], error: null, count: 0 } });

      await listCrawlerRunsForUser(client, USER_UUID, { crawlerID: null, ...options });

      expect(client.from.mock.results[0].value.range).toHaveBeenCalledWith(...range);
    }
  });

  test('answers a total of 0 without a count', async () => {
    const client = createMockClient({ crawler_runs: { data: null, error: null } });

    await expect(listCrawlerRunsForUser(client, USER_UUID, { crawlerID: CRAWLER_ID })).resolves.toEqual({ data: [], total: 0 });
  });

  test('throws on error', async () => {
    const client = createMockClient({ crawler_runs: { data: null, error: { code: 'OTHER', message: 'fail' } } });

    await expect(listCrawlerRunsForUser(client, USER_UUID, { crawlerID: CRAWLER_ID })).rejects.toThrow(
      'Failed to list crawler runs: fail',
    );
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
    expect(chain.is).not.toHaveBeenCalled();
    expect(chain.maybeSingle).toHaveBeenCalled();
  });

  test('queries a run without a crawler with crawler_id IS NULL', async () => {
    const testRun = { ...sampleRun, crawler_id: null, kind: 'test', code: '(input) => input' };
    const client = createMockClient({ crawler_runs: { data: testRun, error: null } });

    await expect(getCrawlerRunForUser(client, RUN_ID, null, USER_UUID)).resolves.toEqual(testRun);

    const chain = client.from.mock.results[0].value;
    expect(chain.eq.mock.calls).toEqual([
      ['id', RUN_ID],
      ['user_uuid', USER_UUID],
    ]);
    expect(chain.is.mock.calls).toEqual([['crawler_id', null]]);
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
