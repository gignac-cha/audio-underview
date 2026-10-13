import { describe, it, expect } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { SYSTEM_USER_UUID } from '@audio-underview/supabase-connector';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { resolveDirectRunStatus } from '../sources/handlers/crawler-runs.ts';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import {
  CODE_RUNNER_ORIGIN,
  SUPABASE_ORIGIN,
  addCrawler,
  configureVault,
  createTestJWT,
  crawlerRow,
  mockPageBody,
  uniqueUUID,
  vaultEnvironment,
  vaultRequests,
  workerRequest,
} from './runtime-harness.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

function permit(crawlerID: string, userUUID: string, level: 'owner' | 'subscriber'): void {
  supabase.tables.crawler_permissions ??= [];
  supabase.tables.crawler_permissions.push({ id: uniqueUUID(), crawler_id: crawlerID, user_uuid: userUUID, level, created_at: '2026-10-13T00:00:00Z' });
}

function ownCrawler(code: string, overrides: Parameters<typeof crawlerRow>[0] = {}) {
  const owner = uniqueUUID();
  const crawler = addCrawler(supabase, crawlerRow({ user_uuid: owner, code, ...overrides }));
  permit(crawler.id, owner, 'owner');
  return { crawler, owner };
}

async function postRun(crawlerID: string, userUUID: string | null, body?: string) {
  const response = await SELF.fetch(await workerRequest(`/crawlers/${crawlerID}/runs`, { method: 'POST', userUUID, body }));
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function crawlerRuns(): Row[] {
  return supabase.tables.crawler_runs ?? [];
}

describe('POST /crawlers/:id/runs', () => {
  it('answers 401 without authentication, with an invalid token, or with a subject that is not a UUID', async () => {
    const { crawler } = ownCrawler('(input) => input');

    expect((await postRun(crawler.id, null)).status).toBe(401);
    const invalid = await SELF.fetch(new Request(`https://worker.example.com/crawlers/${crawler.id}/runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-token' },
    }));
    expect(invalid.status).toBe(401);
    const notUUID = await SELF.fetch(new Request(`https://worker.example.com/crawlers/${crawler.id}/runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await createTestJWT('user-1')}` },
    }));
    expect(notUUID.status).toBe(401);
    expect(await notUUID.json()).toMatchObject({ error: 'unauthorized' });
    expect(supabase.requests).toEqual([]);
  });

  it('runs a crawler of the owner with the environment variables, records the run and answers the result and logs', async () => {
    const { crawler, owner } = ownCrawler('(input, context) => { console.log("got", input.value); return { value: input.value, key: context.environment.KEY }; }');
    await vaultEnvironment(owner, { KEY: 'key-value-0001' });

    const { status, body } = await postRun(crawler.id, owner, JSON.stringify({ input: { value: 7 } }));

    expect(status).toBe(200);
    expect(body).toEqual({
      run_id: expect.any(String),
      status: 'completed',
      result: { value: 7, key: '[REDACTED]' },
      logs: [{ level: 'log', message: 'got 7', timestamp: expect.any(String) }],
      logs_truncated: false,
    });
    expect(crawlerRuns()).toEqual([expect.objectContaining({
      id: body.run_id,
      user_uuid: owner,
      crawler_id: crawler.id,
      status: 'completed',
      result: { value: 7, key: '[REDACTED]' },
      error_code: null,
      error: null,
      logs: body.logs,
      logs_truncated: false,
    })]);
    const run = crawlerRuns()[0];
    expect(Date.parse(String(run.completed_at))).toBeGreaterThanOrEqual(Date.parse(String(run.started_at)));
    expect(await vaultRequests(owner)).toHaveLength(1);
  });

  it('runs a crawler for a subscriber without environment variables', async () => {
    const { crawler, owner } = ownCrawler('(input, context) => Object.keys(context.environment)');
    const subscriber = uniqueUUID();
    permit(crawler.id, subscriber, 'subscriber');
    await vaultEnvironment(owner, { KEY: 'key-value-0001' });
    await vaultEnvironment(subscriber, { KEY: 'subscriber-value' });

    const { status, body } = await postRun(crawler.id, subscriber, JSON.stringify({ input: {} }));

    expect(status).toBe(200);
    expect(body.result).toEqual([]);
    expect(await vaultRequests(subscriber)).toEqual([]);
    expect(crawlerRuns()[0].user_uuid).toBe(subscriber);
  });

  it('answers 404 Crawler not found without a permission, without running it', async () => {
    const { crawler } = ownCrawler('(input) => input');
    const stranger = uniqueUUID();

    const { status, body } = await postRun(crawler.id, stranger);

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'not_found', error_description: 'Crawler not found' });
    expect(crawlerRuns()).toEqual([]);
    expect(supabase.requestsOf('GET', 'crawlers')).toEqual([]);
  });

  it('answers 404 for a crawler that is gone and for an ID that is not a UUID', async () => {
    const user = uniqueUUID();
    const missing = uniqueUUID();
    permit(missing, user, 'owner');

    expect((await postRun(missing, user)).status).toBe(404);
    const invalid = await postRun('not-a-uuid', user);
    expect(invalid).toEqual({ status: 404, body: { error: 'not_found', error_description: 'Crawler not found' } });
  });

  it('runs with the default input of the input schema when there is no body or no input field', async () => {
    const { crawler, owner } = ownCrawler('(input) => input', {
      input_schema: { limit: { type: 'number', default: 5 }, query: { type: 'string' } },
    });

    for (const body of [undefined, '', '{}', '{"other":1}']) {
      const response = await postRun(crawler.id, owner, body);
      expect(response).toMatchObject({ status: 200, body: { status: 'completed', result: { limit: 5 } } });
    }
  });

  it('runs with the input given, null included', async () => {
    const { crawler, owner } = ownCrawler('(input) => [input]');

    expect((await postRun(crawler.id, owner, '{"input":null}')).body.result).toEqual([null]);
    expect((await postRun(crawler.id, owner, '{"input":"text"}')).body.result).toEqual(['text']);
  });

  it('answers 400 when the default input cannot be made', async () => {
    const { crawler, owner } = ownCrawler('(input) => input', { input_schema: [] as unknown as Record<string, unknown> });

    const { status, body } = await postRun(crawler.id, owner);

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: 'Invalid input_schema: expected object, got object' });
    expect(crawlerRuns()).toEqual([]);
  });

  it('answers 400 for a body that is not JSON or not an object', async () => {
    const { crawler, owner } = ownCrawler('(input) => input');

    expect(await postRun(crawler.id, owner, 'not json')).toEqual({
      status: 400,
      body: { error: 'invalid_request', error_description: 'Request body must be valid JSON' },
    });
    for (const body of ['[]', '"text"', '42', 'null']) {
      expect(await postRun(crawler.id, owner, body)).toEqual({
        status: 400,
        body: { error: 'invalid_request', error_description: 'Request body must be a JSON object' },
      });
    }
  });

  it('answers 422 with the error code, the description and the logs when the code fails, and records the run', async () => {
    const { crawler, owner } = ownCrawler('(input, context) => { console.log("start"); throw new Error("broke with " + context.environment.KEY); }');
    await vaultEnvironment(owner, { KEY: 'key-value-0002' });

    const { status, body } = await postRun(crawler.id, owner, '{"input":{}}');

    expect(status).toBe(422);
    expect(body).toMatchObject({
      run_id: expect.any(String),
      status: 'failed',
      error: 'execution_failed',
      error_description: 'broke with [REDACTED]',
      logs_truncated: false,
    });
    expect(body.logs[0]).toMatchObject({ level: 'log', message: 'start' });
    expect(body.logs[1].message).toMatch(/^Error: broke with \[REDACTED\]/);
    expect(crawlerRuns()[0]).toMatchObject({
      status: 'failed',
      error_code: 'execution_failed',
      error: 'CodeRunner error 422: [execution_failed] broke with [REDACTED]',
      result: null,
    });
    expect(JSON.stringify(crawlerRuns())).not.toContain('key-value-0002');
  });

  it('answers 400 for a web crawler without a URL', async () => {
    const { crawler, owner } = ownCrawler('(body) => body', { type: 'web', url_pattern: '.*', input_schema: { body: 'string' } });

    const { status, body } = await postRun(crawler.id, owner);

    expect(status).toBe(400);
    expect(body).toMatchObject({
      status: 'failed',
      error: 'invalid_input',
      error_description: `Crawler ${crawler.id}: no URL available. Provide url in input or set a default in input_schema.`,
    });
  });

  it('runs a web crawler on the page the Lambda fetched', async () => {
    const page = mockPageBody('<h1>Page</h1>');
    const { crawler, owner } = ownCrawler('(body) => body.length', { type: 'web', url_pattern: '.*' });

    const { status, body } = await postRun(crawler.id, owner, '{"input":{"url":"https://example.com/"}}');

    expect(status).toBe(200);
    expect(body.result).toBe(13);
    expect(page.requests).toHaveLength(1);
  });

  it('answers 400 for a Lambda 400 and 502 for a Lambda answer other than 400 and 504', async () => {
    const { crawler, owner } = ownCrawler('(body) => body', { type: 'web', url_pattern: '.*' });
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' })
      .reply(400, JSON.stringify({ error: 'invalid_request', error_description: "Field 'url' must be a valid URL" }));
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' })
      .reply(403, JSON.stringify({ message: 'Forbidden' }));

    const badURL = await postRun(crawler.id, owner, '{"input":{"url":"not a url"}}');
    const forbidden = await postRun(crawler.id, owner, '{"input":{"url":"https://example.com/"}}');

    expect(badURL).toMatchObject({ status: 400, body: { status: 'failed', error: 'execution_error', error_description: "Field 'url' must be a valid URL" } });
    expect(forbidden).toMatchObject({ status: 502, body: { status: 'failed', error: 'execution_error' } });
  });

  it('answers 503 service_unavailable without recording the run when the vault cannot be read', async () => {
    const { crawler, owner } = ownCrawler('(input) => input');
    await configureVault(owner, { resolve: { status: 500, body: { error: 'decrypt_failed' } } });

    const { status, body } = await postRun(crawler.id, owner);

    expect(status).toBe(503);
    expect(body).toEqual({
      error: 'service_unavailable',
      error_description: 'Environment variables could not be read: vault responded 500 decrypt_failed',
    });
    expect(crawlerRuns()).toEqual([]);
  });

  it('answers run_id null when the run cannot be recorded', async () => {
    const { crawler, owner } = ownCrawler('(input) => "done"');
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_runs'
      ? { statusCode: 500, data: { code: 'XX000', message: 'database is down' } }
      : undefined);

    const { status, body } = await postRun(crawler.id, owner);

    expect(status).toBe(200);
    expect(body).toMatchObject({ run_id: null, status: 'completed', result: 'done' });
  });

  it('runs a system crawler for a user with a permission, without environment variables', async () => {
    const user = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: SYSTEM_USER_UUID, code: '(input, context) => Object.keys(context.environment).length' }));
    permit(crawler.id, user, 'subscriber');
    await vaultEnvironment(user, { KEY: 'key-value-0003' });

    expect((await postRun(crawler.id, user)).body.result).toBe(0);
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 405 for another method', async () => {
    const { crawler, owner } = ownCrawler('(input) => input');

    const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs`, { method: 'GET', userUUID: owner }));

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('answers the CORS preflight with 204', async () => {
    const response = await SELF.fetch(new Request(`https://worker.example.com/crawlers/${uniqueUUID()}/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com' },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });
});

describe('GET /crawlers/:id/runs/:runID', () => {
  it('answers the whole run to the user who ran it', async () => {
    const { crawler, owner } = ownCrawler('(input) => { console.log("x"); return 1; }');
    const { body: created } = await postRun(crawler.id, owner);

    const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs/${created.run_id}`, { userUUID: owner }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(crawlerRuns()[0])));
  });

  it('answers 404 Crawler run not found to another user and for another crawler', async () => {
    const { crawler, owner } = ownCrawler('(input) => 1');
    const other = ownCrawler('(input) => 2');
    const { body: created } = await postRun(crawler.id, owner);

    for (const [path, userUUID] of [
      [`/crawlers/${crawler.id}/runs/${created.run_id}`, uniqueUUID()],
      [`/crawlers/${other.crawler.id}/runs/${created.run_id}`, owner],
      [`/crawlers/${crawler.id}/runs/${uniqueUUID()}`, owner],
      [`/crawlers/${crawler.id}/runs/not-a-uuid`, owner],
      [`/crawlers/not-a-uuid/runs/${created.run_id}`, owner],
    ]) {
      const response = await SELF.fetch(await workerRequest(path, { userUUID }));
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found', error_description: 'Crawler run not found' });
    }
  });

  it('answers 401 without authentication', async () => {
    const response = await SELF.fetch(await workerRequest(`/crawlers/${uniqueUUID()}/runs/${uniqueUUID()}`, { userUUID: null }));

    expect(response.status).toBe(401);
  });
});

describe('resolveDirectRunStatus', () => {
  function failed(errorCode: string, error = 'x'): Extract<CrawlerRunOutcome, { status: 'failed' }> {
    return { status: 'failed', type: 'web', error_code: errorCode, error, error_description: 'x', logs: [], logs_truncated: false };
  }

  it.each([
    ['invalid_input', undefined, 400],
    ['execution_failed', 422, 422],
    ['execution_timeout', 422, 422],
    ['invalid_request', 400, 400],
    ['fetch_timeout', 504, 504],
    ['execution_error', 400, 400],
    ['server_error', 504, 504],
    ['server_error', 502, 502],
    ['network_error', 0, 502],
    ['invalid_response', 502, 502],
    ['execution_error', 401, 502],
    ['execution_error', 403, 502],
    ['execution_error', 404, 502],
    ['execution_error', 413, 502],
    ['execution_error', 429, 502],
  ])('%s from status %s answers %s', (errorCode, statusCode, expected) => {
    expect(resolveDirectRunStatus(failed(errorCode), statusCode)).toBe(expected);
  });
});
