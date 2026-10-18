import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import { SUPABASE_ORIGIN, addCrawler, crawlerRow, uniqueUUID, workerRequest } from './runtime-harness.ts';

// GET /crawlers/:id/runs, GET /crawler-test-runs and the run of each: the records of the direct runs
// and the test runs a user started.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

const SUMMARY_FIELDS = ['id', 'crawler_id', 'kind', 'type', 'status', 'error_code', 'logs_truncated', 'started_at', 'completed_at', 'created_at'];

const OFFSET_MESSAGE = "Parameter 'offset' must be a non-negative integer";
const LIMIT_MESSAGE = "Parameter 'limit' must be an integer between 1 and 100";

function addRun(overrides: Row): Row {
  const kind = overrides.kind ?? 'direct';
  const run: Row = {
    id: uniqueUUID(),
    user_uuid: uniqueUUID(),
    crawler_id: uniqueUUID(),
    kind,
    type: 'data',
    code: kind === 'test' ? '(input) => "tested"' : null,
    status: 'completed',
    result: { large: 'result' },
    error_code: null,
    error: null,
    logs: [{ level: 'log', message: 'logged', timestamp: '2026-10-17T00:00:00.000Z' }],
    logs_truncated: false,
    started_at: '2026-10-17T00:00:00.000Z',
    completed_at: '2026-10-17T00:00:01.000Z',
    created_at: '2026-10-17T00:00:01.000Z',
    ...overrides,
  };
  supabase.tables.crawler_runs ??= [];
  supabase.tables.crawler_runs.push(run);
  return run;
}

function summaryOf(run: Row): Row {
  return Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, run[field]]));
}

async function get(path: string, userUUID: string | null) {
  const response = await SELF.fetch(await workerRequest(path, { userUUID }));
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
}

describe('GET /crawlers/:id/runs', () => {
  it('lists the direct and test runs of the user for the crawler, newest first, without the result, the logs and the code', async () => {
    const user = uniqueUUID();
    const crawlerID = uniqueUUID();
    const oldest = addRun({ user_uuid: user, crawler_id: crawlerID, created_at: '2026-10-17T01:00:00.000Z' });
    const newest = addRun({ user_uuid: user, crawler_id: crawlerID, kind: 'test', type: 'web', created_at: '2026-10-17T03:00:00.000Z' });
    const failed = addRun({
      user_uuid: user,
      crawler_id: crawlerID,
      status: 'failed',
      result: null,
      error_code: 'execution_failed',
      error: 'CodeRunner error 422: [execution_failed] broke',
      logs_truncated: true,
      created_at: '2026-10-17T02:00:00.000Z',
    });
    // Before migration 014 a run had no type
    const recordedBefore = addRun({ user_uuid: user, crawler_id: crawlerID, type: null, created_at: '2026-10-16T00:00:00.000Z' });
    addRun({ user_uuid: uniqueUUID(), crawler_id: crawlerID, created_at: '2026-10-17T04:00:00.000Z' });
    addRun({ user_uuid: user, crawler_id: uniqueUUID(), created_at: '2026-10-17T05:00:00.000Z' });
    addRun({ user_uuid: user, crawler_id: null, kind: 'test', created_at: '2026-10-17T06:00:00.000Z' });

    const { status, body } = await get(`/crawlers/${crawlerID}/runs`, user);

    expect(status).toBe(200);
    expect(body).toEqual({
      data: [newest, failed, oldest, recordedBefore].map(summaryOf),
      total: 4,
      offset: 0,
      limit: 20,
    });
    // Only the runs of the user are listed, so neither the crawler nor its permissions are read
    expect(supabase.requestsOf('GET', 'crawlers')).toEqual([]);
    expect(supabase.requestsOf('GET', 'crawler_permissions')).toEqual([]);
  });

  it('lists the runs of a crawler the user no longer has, which are still the runs of the user', async () => {
    const user = uniqueUUID();
    const crawlerID = uniqueUUID();
    const run = addRun({ user_uuid: user, crawler_id: crawlerID });

    expect((await get(`/crawlers/${crawlerID}/runs`, user)).body.data).toEqual([summaryOf(run)]);
  });

  it('orders the runs created at the same time by ID, the greater first', async () => {
    const user = uniqueUUID();
    const crawlerID = uniqueUUID();
    const createdAt = '2026-10-17T01:00:00.000Z';
    const lesser = addRun({ id: 'aaaaaaaa-0000-4000-8000-000000000000', user_uuid: user, crawler_id: crawlerID, created_at: createdAt });
    const greater = addRun({ id: 'bbbbbbbb-0000-4000-8000-000000000000', user_uuid: user, crawler_id: crawlerID, created_at: createdAt });

    expect((await get(`/crawlers/${crawlerID}/runs`, user)).body.data.map((run: Row) => run.id)).toEqual([greater.id, lesser.id]);
  });

  it('pages with offset and limit, with the total of every run', async () => {
    const user = uniqueUUID();
    const crawlerID = uniqueUUID();
    const runs = [1, 2, 3, 4, 5].map((hour) => addRun({ user_uuid: user, crawler_id: crawlerID, created_at: `2026-10-17T0${hour}:00:00.000Z` }));

    const page = await get(`/crawlers/${crawlerID}/runs?offset=1&limit=2`, user);
    const past = await get(`/crawlers/${crawlerID}/runs?offset=10&limit=100`, user);

    expect(page.body).toEqual({ data: [runs[3], runs[2]].map(summaryOf), total: 5, offset: 1, limit: 2 });
    expect(past.body).toEqual({ data: [], total: 5, offset: 10, limit: 100 });
  });

  it('answers an empty list when the user has no run of the crawler', async () => {
    expect((await get(`/crawlers/${uniqueUUID()}/runs`, uniqueUUID())).body).toEqual({ data: [], total: 0, offset: 0, limit: 20 });
  });

  it.each([
    ['offset=-1', OFFSET_MESSAGE],
    ['offset=abc', OFFSET_MESSAGE],
    ['offset=1.5', OFFSET_MESSAGE],
    ['limit=0', LIMIT_MESSAGE],
    ['limit=101', LIMIT_MESSAGE],
    ['limit=2.5', LIMIT_MESSAGE],
    ['limit=many', LIMIT_MESSAGE],
  ])('answers 400 for %s without reading the runs', async (query, message) => {
    const { status, body } = await get(`/crawlers/${uniqueUUID()}/runs?${query}`, uniqueUUID());

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: message });
    expect(supabase.requests).toEqual([]);
  });

  it('answers 404 Crawler not found for a crawler ID that is not a UUID', async () => {
    expect(await get('/crawlers/not-a-uuid/runs', uniqueUUID())).toMatchObject({
      status: 404,
      body: { error: 'not_found', error_description: 'Crawler not found' },
    });
  });

  it('answers 401 without authentication', async () => {
    expect((await get(`/crawlers/${uniqueUUID()}/runs`, null)).status).toBe(401);
  });
});

describe('GET /crawler-test-runs', () => {
  it('lists the test runs of the user without a crawler, newest first, without the result, the logs and the code', async () => {
    const user = uniqueUUID();
    const first = addRun({ user_uuid: user, crawler_id: null, kind: 'test', created_at: '2026-10-17T01:00:00.000Z' });
    const second = addRun({ user_uuid: user, crawler_id: null, kind: 'test', type: 'web', status: 'failed', error_code: 'invalid_input', created_at: '2026-10-17T02:00:00.000Z' });
    addRun({ user_uuid: user, kind: 'test', created_at: '2026-10-17T03:00:00.000Z' });
    addRun({ user_uuid: user, created_at: '2026-10-17T04:00:00.000Z' });
    addRun({ user_uuid: uniqueUUID(), crawler_id: null, kind: 'test', created_at: '2026-10-17T05:00:00.000Z' });

    const { status, body } = await get('/crawler-test-runs', user);

    expect(status).toBe(200);
    expect(body).toEqual({ data: [second, first].map(summaryOf), total: 2, offset: 0, limit: 20 });
  });

  it('pages with offset and limit', async () => {
    const user = uniqueUUID();
    const runs = [1, 2, 3].map((hour) => addRun({ user_uuid: user, crawler_id: null, kind: 'test', created_at: `2026-10-17T0${hour}:00:00.000Z` }));

    expect((await get('/crawler-test-runs?offset=2&limit=1', user)).body).toEqual({ data: [summaryOf(runs[0])], total: 3, offset: 2, limit: 1 });
  });

  it.each([
    ['offset=-5', OFFSET_MESSAGE],
    ['limit=1000', LIMIT_MESSAGE],
  ])('answers 400 for %s without reading the runs', async (query, message) => {
    const { status, body } = await get(`/crawler-test-runs?${query}`, uniqueUUID());

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: message });
    expect(supabase.requests).toEqual([]);
  });

  it('answers 401 without authentication', async () => {
    expect((await get('/crawler-test-runs', null)).status).toBe(401);
  });
});

describe('GET /crawler-test-runs/:runID', () => {
  it('answers the whole test run without a crawler, its code included, to the user who ran it', async () => {
    const user = uniqueUUID();
    const run = addRun({ user_uuid: user, crawler_id: null, kind: 'test', code: '(input) => "draft"' });

    expect(await get(`/crawler-test-runs/${run.id}`, user)).toMatchObject({ status: 200, body: run });
  });

  it('answers 404 Crawler run not found for the run of another user, the run of a crawler, and an ID that is not a run', async () => {
    const user = uniqueUUID();
    const ofAnother = addRun({ user_uuid: uniqueUUID(), crawler_id: null, kind: 'test' });
    const ofCrawler = addRun({ user_uuid: user, kind: 'test' });

    for (const runID of [String(ofAnother.id), String(ofCrawler.id), uniqueUUID(), 'not-a-uuid', `${ofCrawler.id}x`]) {
      expect(await get(`/crawler-test-runs/${runID}`, user), runID).toMatchObject({
        status: 404,
        body: { error: 'not_found', error_description: 'Crawler run not found' },
      });
    }
  });

  it('answers 405 with Allow GET for another method', async () => {
    const run = addRun({ crawler_id: null, kind: 'test' });

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await SELF.fetch(await workerRequest(`/crawler-test-runs/${run.id}`, { method, userUUID: String(run.user_uuid) }));
      await response.text();
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET');
    }
  });

  it('answers 401 without authentication', async () => {
    expect((await get(`/crawler-test-runs/${uniqueUUID()}`, null)).status).toBe(401);
  });
});

describe('GET /crawlers/:id/runs/:runID', () => {
  it('answers a test run of the crawler, its code included', async () => {
    const user = uniqueUUID();
    const run = addRun({ user_uuid: user, kind: 'test', code: '(input) => "unsaved change"' });

    expect(await get(`/crawlers/${run.crawler_id}/runs/${run.id}`, user)).toMatchObject({ status: 200, body: run });
  });

  it('answers 404 for a test run without a crawler, the run of another crawler, and the run of another user', async () => {
    const user = uniqueUUID();
    const crawlerID = uniqueUUID();
    const withoutCrawler = addRun({ user_uuid: user, crawler_id: null, kind: 'test' });
    const ofOtherCrawler = addRun({ user_uuid: user, kind: 'test' });
    const ofAnother = addRun({ user_uuid: uniqueUUID(), crawler_id: crawlerID, kind: 'test' });

    for (const runID of [withoutCrawler.id, ofOtherCrawler.id, ofAnother.id]) {
      expect(await get(`/crawlers/${crawlerID}/runs/${runID}`, user), String(runID)).toMatchObject({
        status: 404,
        body: { error: 'not_found', error_description: 'Crawler run not found' },
      });
    }
  });
});

describe('the record of a run, from the run to the history', () => {
  it('lists and answers the direct run and the test run of a crawler', async () => {
    const owner = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: owner, code: '(input) => "saved"' }));
    supabase.tables.crawler_permissions = [{ id: uniqueUUID(), crawler_id: crawler.id, user_uuid: owner, level: 'owner', created_at: '2026-10-13T00:00:00Z' }];

    const direct = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs`, { method: 'POST', userUUID: owner }));
    const directRun = await direct.json() as Row;
    const test = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/test-runs`, {
      method: 'POST',
      userUUID: owner,
      body: JSON.stringify({ code: '(input) => "changed"' }),
    }));
    const testRun = await test.json() as Row;

    const list = await get(`/crawlers/${crawler.id}/runs`, owner);
    expect(list.body.total).toBe(2);
    expect(new Set(list.body.data.map((run: Row) => `${run.kind} ${run.id}`))).toEqual(new Set([`direct ${directRun.run_id}`, `test ${testRun.run_id}`]));
    expect(list.body.data.every((run: Row) => Object.keys(run).sort().join() === [...SUMMARY_FIELDS].sort().join())).toBe(true);

    const detail = await get(`/crawlers/${crawler.id}/runs/${testRun.run_id}`, owner);
    expect(detail.body).toMatchObject({ id: testRun.run_id, kind: 'test', type: 'data', code: '(input) => "changed"', result: 'changed' });
  });

  it('lists and answers a test run without a crawler', async () => {
    const user = uniqueUUID();
    const created = await SELF.fetch(await workerRequest('/crawler-test-runs', {
      method: 'POST',
      userUUID: user,
      body: JSON.stringify({ type: 'data', code: '(input) => "draft"' }),
    }));
    const { run_id: runID } = await created.json() as Row;

    const list = await get('/crawler-test-runs', user);
    const detail = await get(`/crawler-test-runs/${runID}`, user);

    expect(list.body).toMatchObject({ data: [{ id: runID, crawler_id: null, kind: 'test', type: 'data', status: 'completed' }], total: 1 });
    expect(detail.body).toMatchObject({ id: runID, user_uuid: user, crawler_id: null, kind: 'test', code: '(input) => "draft"', result: 'draft' });
  });
});

describe('GET /help', () => {
  it('names the endpoints of the runs and the test runs', async () => {
    const response = await SELF.fetch(await workerRequest('/help', { userUUID: null }));
    const help = await response.json() as { endpoints: { method: string; path: string }[] };

    const endpoints = help.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    expect(endpoints).toEqual(expect.arrayContaining([
      'POST /crawlers/:id/runs',
      'GET /crawlers/:id/runs',
      'GET /crawlers/:id/runs/:runID',
      'POST /crawlers/:id/test-runs',
      'POST /crawler-test-runs',
      'GET /crawler-test-runs',
      'GET /crawler-test-runs/:runID',
    ]));
  });
});
