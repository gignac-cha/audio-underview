import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { Logger } from '@audio-underview/logger';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import {
  SUPABASE_ORIGIN,
  addCrawler,
  configureVault,
  crawlerRow,
  mockPageBody,
  uniqueUUID,
  vaultEnvironment,
  vaultRequests,
  workerRequest,
} from './runtime-harness.ts';

// POST /crawlers/:id/test-runs and POST /crawler-test-runs: the code of the editor, run and recorded
// as a test run, of a saved crawler or of code without a crawler.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

afterEach(() => {
  vi.restoreAllMocks();
});

function ownCrawler(overrides: Parameters<typeof crawlerRow>[0] = {}) {
  const owner = uniqueUUID();
  const crawler = addCrawler(supabase, crawlerRow({ user_uuid: owner, code: '(input) => "saved code"', ...overrides }));
  return { crawler, owner };
}

async function post(path: string, userUUID: string | null, body?: unknown) {
  const response = await SELF.fetch(await workerRequest(path, {
    method: 'POST',
    userUUID,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
}

function crawlerRuns(): Row[] {
  return supabase.tables.crawler_runs ?? [];
}

function fileRows(): Row[] {
  return supabase.tables.crawler_files ?? [];
}

function expectExpiresInADay(row: Row): void {
  const hours = (Date.parse(String(row.expires_at)) - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(23.9);
  expect(hours).toBeLessThan(24.1);
}

/** The warnings of the worker logger, which the run of a web crawler uses for url_pattern */
function spyOnWarnings(): unknown[][] {
  const warnings: unknown[][] = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(function (this: Logger, ...parts: unknown[]) {
    warnings.push(parts);
  });
  return warnings;
}

const CODE_MESSAGE = "Field 'code' is required and must be a non-empty string";

// The fields both test runs check, with the error description of each
const INVALID_FIELDS: [string, Record<string, unknown>, string][] = [
  ['no code', {}, CODE_MESSAGE],
  ['a blank code', { code: ' \n\t' }, CODE_MESSAGE],
  ['a code that is not a string', { code: 42 }, CODE_MESSAGE],
  ['a code over 1,048,576 characters', { code: `(input) => input${' '.repeat(1_048_577 - 16)}` }, "Field 'code' must not exceed 1048576 characters"],
  ['a url_pattern that is not a string', { code: '(body) => body', url_pattern: 5 }, "Field 'url_pattern' must be a string"],
  ['a url_pattern that does not parse', { code: '(body) => body', url_pattern: '[invalid' }, "Field 'url_pattern' contains potentially unsafe regex pattern"],
  ['an unsafe url_pattern', { code: '(body) => body', url_pattern: '(a+)+$' }, "Field 'url_pattern' contains potentially unsafe regex pattern"],
  ['a url_pattern over 2048 characters', { code: '(body) => body', url_pattern: 'a'.repeat(2049) }, "Field 'url_pattern' must not exceed 2048 characters"],
  ['an input_schema that is an array', { code: '(input) => input', input_schema: [] }, "Field 'input_schema' must be a JSON object"],
  ['an input_schema that is null', { code: '(input) => input', input_schema: null }, "Field 'input_schema' must be a JSON object"],
  ['environment_variable_names that are not an array', { code: '(input) => input', environment_variable_names: 'KEY' }, "Field 'environment_variable_names' must be an array of strings"],
  ['an environment variable name that is not valid', { code: '(input) => input', environment_variable_names: ['key'] }, 'Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$'],
  ['a duplicate environment variable name', { code: '(input) => input', environment_variable_names: ['KEY', 'KEY'] }, "Field 'environment_variable_names' must not contain duplicates"],
  ['101 environment variable names', {
    code: '(input) => input',
    environment_variable_names: Array.from({ length: 101 }, (_, index) => `KEY_${index}`),
  }, "Field 'environment_variable_names' must not exceed 100 names"],
];

describe('POST /crawlers/:id/test-runs', () => {
  it('answers 401 without authentication', async () => {
    const { crawler } = ownCrawler();

    expect((await post(`/crawlers/${crawler.id}/test-runs`, null, { code: '(input) => input' })).status).toBe(401);
    expect(supabase.requests).toEqual([]);
  });

  it('runs the code of the body over the saved crawler and records a test run with the code', async () => {
    const { crawler, owner } = ownCrawler({ input_schema: { limit: { type: 'number', default: 3 } } });
    const code = '(input) => { console.log("testing"); return { ran: "test code", input }; }';

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { code });

    expect(status).toBe(200);
    expect(body).toEqual({
      run_id: expect.any(String),
      status: 'completed',
      result: { ran: 'test code', input: { limit: 3 } },
      logs: [{ level: 'log', message: 'testing', timestamp: expect.any(String) }],
      logs_truncated: false,
    });
    expect(crawlerRuns()).toEqual([expect.objectContaining({
      id: body.run_id,
      user_uuid: owner,
      crawler_id: crawler.id,
      kind: 'test',
      type: 'data',
      code,
      status: 'completed',
      result: { ran: 'test code', input: { limit: 3 } },
      error_code: null,
      error: null,
    })]);
    // The saved crawler stays as it was
    expect(supabase.tables.crawlers[0].code).toBe('(input) => "saved code"');
    expect(supabase.requestsOf('PATCH', 'crawlers')).toEqual([]);
  });

  it('runs on the input_schema of the body for a data crawler, and on the input given as it is', async () => {
    const { crawler, owner } = ownCrawler({ input_schema: { limit: { type: 'number', default: 3 } } });
    const path = `/crawlers/${crawler.id}/test-runs`;

    const fromSchema = await post(path, owner, { code: '(input) => input', input_schema: { page: { type: 'number', default: 9 } } });
    const given = await post(path, owner, { code: '(input) => [input]', input: null });

    expect(fromSchema.body.result).toEqual({ page: 9 });
    expect(given.body.result).toEqual([null]);
  });

  it('gives the code the environment variables the body declares, or else the saved declaration', async () => {
    const { crawler, owner } = ownCrawler({ environment_variable_names: ['SAVED_KEY'] });
    await vaultEnvironment(owner, { SAVED_KEY: 'saved-value-0001', NEW_KEY: 'new-value-0002' });
    const code = '(input, context) => ({ names: Object.keys(context.environment), saved: context.environment.SAVED_KEY ?? null, added: context.environment.NEW_KEY ?? null })';
    const path = `/crawlers/${crawler.id}/test-runs`;

    const declared = await post(path, owner, { code, environment_variable_names: ['NEW_KEY'] });
    const saved = await post(path, owner, { code });
    const none = await post(path, owner, { code, environment_variable_names: [] });

    expect(declared.body.result).toEqual({ names: ['NEW_KEY'], saved: null, added: '[REDACTED]' });
    expect(saved.body.result).toEqual({ names: ['SAVED_KEY'], saved: '[REDACTED]', added: null });
    expect(none.body.result).toEqual({ names: [], saved: null, added: null });
    // Two of the three runs declare a name
    expect(await vaultRequests(owner)).toHaveLength(2);
    expect(JSON.stringify(crawlerRuns())).not.toContain('saved-value-0001');
    expect(JSON.stringify(crawlerRuns())).not.toContain('new-value-0002');
  });

  it('keeps the saved type, whatever type the body names', async () => {
    const { crawler, owner } = ownCrawler();

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { type: 'web', code: '(input) => typeof input' });

    expect(status).toBe(200);
    expect(body.result).toBe('object');
    expect(crawlerRuns()[0]).toMatchObject({ kind: 'test', type: 'data' });
  });

  it('runs a web crawler on the page with the url_pattern of the body, or else the saved one, and the body input schema', async () => {
    const { crawler, owner } = ownCrawler({ type: 'web', url_pattern: '^https://saved\\.example\\.com/', input_schema: { body: 'string' } });
    const path = `/crawlers/${crawler.id}/test-runs`;
    const warnings = spyOnWarnings();
    const pages = [mockPageBody('<p>one</p>'), mockPageBody('<p>two</p>')];

    const overridden = await post(path, owner, {
      code: '(body) => body.length',
      url_pattern: '^https://test\\.example\\.com/',
      // A web crawler always takes the page body
      input_schema: { url: { type: 'string', default: 'https://ignored.example.com/' } },
      input: { url: 'https://saved.example.com/page' },
    });
    const kept = await post(path, owner, { code: '(body) => body', input: { url: 'https://saved.example.com/page' } });

    expect(overridden).toMatchObject({ status: 200, body: { status: 'completed', result: 10 } });
    expect(kept).toMatchObject({ status: 200, body: { status: 'completed', result: '<p>two</p>' } });
    expect(pages.map((page) => page.requests)).toEqual([
      [expect.objectContaining({ url: 'https://saved.example.com/page' })],
      [expect.objectContaining({ url: 'https://saved.example.com/page' })],
    ]);
    // Only the run with the url_pattern of the body warns about the saved URL
    const mismatches = warnings.filter(([message]) => message === 'URL does not match crawler url_pattern');
    expect(mismatches).toEqual([[
      'URL does not match crawler url_pattern',
      expect.objectContaining({ urlPattern: '^https://test\\.example\\.com/', crawlerID: crawler.id }),
      { function: 'runCrawler' },
    ]]);
    expect(crawlerRuns().map((run) => run.type)).toEqual(['web', 'web']);
  });

  it('answers 400 for a web crawler without a URL, as a direct run', async () => {
    const { crawler, owner } = ownCrawler({ type: 'web', url_pattern: '.*', input_schema: { body: 'string' } });

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { code: '(body) => body' });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      status: 'failed',
      error: 'invalid_input',
      error_description: `Crawler ${crawler.id}: no URL available. Provide url in input or set a default in input_schema.`,
    });
    expect(crawlerRuns()[0]).toMatchObject({ kind: 'test', type: 'web', code: '(body) => body', status: 'failed', error_code: 'invalid_input' });
  });

  it('answers 422 when the code fails, and records the failed test run with its code', async () => {
    const { crawler, owner } = ownCrawler();
    const code = '(input) => { throw new Error("test broke"); }';

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { code });

    expect(status).toBe(422);
    expect(body).toMatchObject({ run_id: expect.any(String), status: 'failed', error: 'execution_failed', error_description: 'test broke' });
    expect(crawlerRuns()[0]).toMatchObject({ id: body.run_id, kind: 'test', crawler_id: crawler.id, code, status: 'failed', error_code: 'execution_failed' });
  });

  it('keeps a saved file for 24 hours, tied to the crawler and to no scheduler run', async () => {
    const { crawler, owner } = ownCrawler();

    const { body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, {
      code: 'async (input, context) => context.files.save("test file", { name: "test.txt" })',
    });

    expect(body.result).toEqual({ file_id: expect.any(String), name: 'test.txt', content_type: 'application/octet-stream', size: 9 });
    expect(fileRows()).toEqual([expect.objectContaining({ id: body.result.file_id, user_uuid: owner, crawler_id: crawler.id, run_id: null })]);
    expectExpiresInADay(fileRows()[0]);
  });

  it('answers 503 without recording the run when the vault cannot be read', async () => {
    const { crawler, owner } = ownCrawler({ environment_variable_names: ['KEY'] });
    await configureVault(owner, { resolve: { status: 500, body: { error: 'decrypt_failed' } } });

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { code: '(input) => input' });

    expect(status).toBe(503);
    expect(body).toEqual({
      error: 'service_unavailable',
      error_description: 'Environment variables could not be read: vault responded 500 decrypt_failed',
    });
    expect(crawlerRuns()).toEqual([]);
  });

  it('answers run_id null when the run cannot be recorded', async () => {
    const { crawler, owner } = ownCrawler();
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_runs'
      ? { statusCode: 500, data: { code: 'XX000', message: 'database is down' } }
      : undefined);

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { code: '(input) => "done"' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ run_id: null, status: 'completed', result: 'done' });
  });

  it('answers 400 when the default input cannot be made', async () => {
    const { crawler, owner } = ownCrawler({ input_schema: [] as unknown as Record<string, unknown> });

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, { code: '(input) => input' });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: 'Invalid input_schema: expected object, got object' });
    expect(crawlerRuns()).toEqual([]);
  });

  it('answers 404 Crawler not found for a crawler of another user, a subscribed one included, without running it', async () => {
    const { crawler } = ownCrawler();
    const subscriber = uniqueUUID();
    supabase.tables.crawler_permissions = [{ id: uniqueUUID(), crawler_id: crawler.id, user_uuid: subscriber, level: 'subscriber', created_at: '2026-10-13T00:00:00Z' }];

    for (const [crawlerID, userUUID] of [[crawler.id, subscriber], [crawler.id, uniqueUUID()], [uniqueUUID(), subscriber], ['not-a-uuid', subscriber]]) {
      const response = await post(`/crawlers/${crawlerID}/test-runs`, userUUID, { code: '(input) => "other code"' });
      expect(response.status, crawlerID).toBe(404);
      expect(response.body).toEqual({ error: 'not_found', error_description: 'Crawler not found' });
    }
    expect(crawlerRuns()).toEqual([]);
  });

  it('answers 400 for a body that is missing, not JSON or not an object, before the crawler is read', async () => {
    const { crawler, owner } = ownCrawler();
    const path = `/crawlers/${crawler.id}/test-runs`;

    for (const body of [undefined, '', 'not json']) {
      expect(await post(path, owner, body)).toMatchObject({
        status: 400,
        body: { error: 'invalid_request', error_description: 'Request body must be valid JSON' },
      });
    }
    for (const body of ['[]', '"text"', '42', 'null']) {
      expect(await post(path, owner, body)).toMatchObject({
        status: 400,
        body: { error: 'invalid_request', error_description: 'Request body must be a JSON object' },
      });
    }
    expect(supabase.requests).toEqual([]);
  });

  it.each(INVALID_FIELDS)('answers 400 for %s, before the crawler is read', async (_, fields, message) => {
    const { crawler, owner } = ownCrawler();

    const { status, body } = await post(`/crawlers/${crawler.id}/test-runs`, owner, fields);

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: message });
    expect(supabase.requests).toEqual([]);
  });

  it('answers 405 with Allow POST for another method', async () => {
    const { crawler, owner } = ownCrawler();

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/test-runs`, { method, userUUID: owner }));
      await response.text();
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
  });
});

describe('POST /crawler-test-runs', () => {
  it('answers 401 without authentication', async () => {
    expect((await post('/crawler-test-runs', null, { type: 'data', code: '(input) => input' })).status).toBe(401);
    expect(supabase.requests).toEqual([]);
  });

  it('runs data code without a crawler on the defaults, and records a test run without a crawler', async () => {
    const user = uniqueUUID();
    await vaultEnvironment(user, { KEY: 'unused-value-0001' });
    const code = '(input, context) => ({ input, names: Object.keys(context.environment) })';

    const { status, body } = await post('/crawler-test-runs', user, { type: 'data', code });

    expect(status).toBe(200);
    expect(body).toEqual({ run_id: expect.any(String), status: 'completed', result: { input: {}, names: [] }, logs: [], logs_truncated: false });
    // No declared name, so the vault is not called
    expect(await vaultRequests(user)).toEqual([]);
    expect(crawlerRuns()).toEqual([expect.objectContaining({
      id: body.run_id,
      user_uuid: user,
      crawler_id: null,
      kind: 'test',
      type: 'data',
      code,
      status: 'completed',
    })]);
  });

  it('runs on the input_schema and the input of the body', async () => {
    const user = uniqueUUID();

    const fromSchema = await post('/crawler-test-runs', user, { type: 'data', code: '(input) => input', input_schema: { size: { type: 'number', default: 4 } } });
    const given = await post('/crawler-test-runs', user, { type: 'data', code: '(input) => input', input_schema: { size: { default: 4 } }, input: { size: 8 } });

    expect(fromSchema.body.result).toEqual({ size: 4 });
    expect(given.body.result).toEqual({ size: 8 });
  });

  it('gives the code the declared environment variables of the user, who writes it', async () => {
    const user = uniqueUUID();
    await vaultEnvironment(user, { KEY: 'test-value-0001', OTHER: 'other-value-0002' });

    const { body } = await post('/crawler-test-runs', user, {
      type: 'data',
      code: '(input, context) => { console.log(context.environment.KEY); return Object.keys(context.environment); }',
      environment_variable_names: ['KEY', 'NOT_SET'],
    });

    expect(body.result).toEqual(['KEY']);
    expect(body.logs.map((entry: { message: string }) => entry.message)).toEqual(['[REDACTED]']);
    expect(await vaultRequests(user)).toHaveLength(1);
  });

  it('runs web code on the page without a url_pattern, so without a warning', async () => {
    const user = uniqueUUID();
    const warnings = spyOnWarnings();
    const page = mockPageBody('<h1>Test</h1>');

    const { status, body } = await post('/crawler-test-runs', user, { type: 'web', code: '(body) => body.length', input: { url: 'https://example.com/page' } });

    expect(status).toBe(200);
    expect(body.result).toBe(13);
    expect(page.requests).toEqual([expect.objectContaining({ url: 'https://example.com/page' })]);
    expect(warnings.filter(([message]) => String(message).includes('url_pattern'))).toEqual([]);
    expect(crawlerRuns()[0]).toMatchObject({ crawler_id: null, kind: 'test', type: 'web', code: '(body) => body.length' });
  });

  it('warns with the url_pattern of the body for a web URL that does not match it', async () => {
    const warnings = spyOnWarnings();
    mockPageBody('page');

    const { status } = await post('/crawler-test-runs', uniqueUUID(), {
      type: 'web',
      code: '(body) => body',
      url_pattern: '^https://only\\.example\\.com/',
      input: { url: 'https://other.example.com/' },
    });

    expect(status).toBe(200);
    expect(warnings.filter(([message]) => message === 'URL does not match crawler url_pattern')).toEqual([[
      'URL does not match crawler url_pattern',
      expect.objectContaining({ urlPattern: '^https://only\\.example\\.com/', crawlerID: null }),
      { function: 'runCrawler' },
    ]]);
  });

  it('answers 400 for web code without a URL, naming the test run', async () => {
    const { status, body } = await post('/crawler-test-runs', uniqueUUID(), {
      type: 'web',
      code: '(body) => body',
      // A web crawler always takes the page body, so a default URL here is not used
      input_schema: { url: { type: 'string', default: 'https://ignored.example.com/' } },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      status: 'failed',
      error: 'invalid_input',
      error_description: 'Crawler test run: no URL available. Provide url in input or set a default in input_schema.',
    });
    expect(crawlerRuns()[0]).toMatchObject({ crawler_id: null, kind: 'test', type: 'web', status: 'failed' });
  });

  it('answers 422 when the code fails, and records the failure', async () => {
    const user = uniqueUUID();
    const code = '() => { throw new Error("draft broke"); }';

    const { status, body } = await post('/crawler-test-runs', user, { type: 'data', code });

    expect(status).toBe(422);
    expect(body).toMatchObject({ status: 'failed', error: 'execution_failed', error_description: 'draft broke' });
    expect(crawlerRuns()[0]).toMatchObject({ id: body.run_id, crawler_id: null, kind: 'test', code, error_code: 'execution_failed' });
  });

  it('keeps a saved file for 24 hours, tied to no crawler and to no scheduler run', async () => {
    const user = uniqueUUID();

    const { body } = await post('/crawler-test-runs', user, {
      type: 'data',
      code: 'async (input, context) => context.files.save("draft", { name: "draft.txt" })',
    });

    expect(body.result).toMatchObject({ file_id: expect.any(String), name: 'draft.txt', size: 5 });
    expect(fileRows()).toEqual([expect.objectContaining({ id: body.result.file_id, user_uuid: user, crawler_id: null, run_id: null })]);
    expectExpiresInADay(fileRows()[0]);
  });

  it('answers 503 without recording the run when the vault cannot be read', async () => {
    const user = uniqueUUID();
    await configureVault(user, { resolve: { status: 'unreachable' } });

    const { status, body } = await post('/crawler-test-runs', user, { type: 'data', code: '(input) => input', environment_variable_names: ['KEY'] });

    expect(status).toBe(503);
    expect(body).toEqual({ error: 'service_unavailable', error_description: 'Environment variables could not be read: vault could not be reached' });
    expect(crawlerRuns()).toEqual([]);
  });

  it('answers run_id null when the run cannot be recorded', async () => {
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_runs'
      ? { statusCode: 500, data: { code: 'XX000', message: 'database is down' } }
      : undefined);

    const { status, body } = await post('/crawler-test-runs', uniqueUUID(), { type: 'data', code: '(input) => "done"' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ run_id: null, status: 'completed', result: 'done' });
  });

  it.each([
    ['no type', {}],
    ['another type', { type: 'api' }],
    ['a type that is not a string', { type: 1 }],
    ['a type in another case', { type: 'Web' }],
  ])('answers 400 for %s, running nothing', async (_, fields) => {
    const { status, body } = await post('/crawler-test-runs', uniqueUUID(), { code: '(input) => input', ...fields });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: "Field 'type' must be 'web' or 'data'" });
    expect(supabase.requests).toEqual([]);
  });

  it('answers 400 for a body that is missing, not JSON or not an object', async () => {
    const user = uniqueUUID();

    for (const body of [undefined, 'not json']) {
      expect((await post('/crawler-test-runs', user, body)).body).toEqual({ error: 'invalid_request', error_description: 'Request body must be valid JSON' });
    }
    for (const body of ['[]', 'null', '"data"']) {
      expect((await post('/crawler-test-runs', user, body)).body).toEqual({ error: 'invalid_request', error_description: 'Request body must be a JSON object' });
    }
    expect(supabase.requests).toEqual([]);
  });

  it.each(INVALID_FIELDS)('answers 400 for %s', async (_, fields, message) => {
    const { status, body } = await post('/crawler-test-runs', uniqueUUID(), { type: 'web', ...fields });

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request', error_description: message });
    expect(supabase.requests).toEqual([]);
  });

  it('answers 405 with Allow GET, POST for another method', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await SELF.fetch(await workerRequest('/crawler-test-runs', { method, userUUID: uniqueUUID() }));
      await response.text();
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, POST');
    }
  });
});
