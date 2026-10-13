import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import { useInMemorySupabase, type Row } from './in-memory-supabase.ts';
import {
  CODE_RUNNER_ORIGIN,
  SUPABASE_ORIGIN,
  WORKER_URL,
  addCrawler,
  configureVault,
  crawlerRow,
  uniqueUUID,
  vaultEnvironment,
  vaultRequests,
  workerRequest,
} from './runtime-harness.ts';

// POST /crawlers/:id/runs and GET /crawlers/:id/runs/:runID: the cases beyond crawler-runs-routes.test.ts.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const SECRET = 'logged-secret-value-9';

afterEach(() => {
  vi.restoreAllMocks();
});

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

async function post(crawlerID: string, userUUID: string, body?: unknown) {
  const response = await SELF.fetch(await workerRequest(`/crawlers/${crawlerID}/runs`, {
    method: 'POST',
    userUUID,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
}

function crawlerRuns(): Row[] {
  return supabase.tables.crawler_runs ?? [];
}

async function tokenRequest(path: string, token: string, method = 'POST'): Promise<Response> {
  return SELF.fetch(new Request(`${WORKER_URL}${path}`, { method, headers: { Origin: 'https://example.com', Authorization: token } }));
}

describe('authentication', () => {
  it('answers 401 unauthorized to an expired token, a wrong secret, a scheme that is not Bearer and garbage, and reads nothing', async () => {
    const { crawler } = ownCrawler('(input) => input');
    const user = uniqueUUID();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const expired = await signJWT({ sub: user, iat: 1, exp: 2 }, JWT_SECRET);
    const wrongSecret = await signJWT({ sub: user, iat: 1, exp: future }, 'another-secret');

    for (const authorization of [`Bearer ${expired}`, `Bearer ${wrongSecret}`, 'Bearer garbage', `Basic ${btoa('a:b')}`, 'Bearer ']) {
      const response = await tokenRequest(`/crawlers/${crawler.id}/runs`, authorization);
      expect(response.status, authorization).toBe(401);
      expect((await response.json() as { error: string }).error).toBe('unauthorized');
    }
    expect(supabase.requests).toEqual([]);
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 401 to the record of a run and to the file and the variables routes as well', async () => {
    for (const path of [`/crawlers/${uniqueUUID()}/runs/${uniqueUUID()}`, `/files/${uniqueUUID()}`, '/environment-variables']) {
      const response = await tokenRequest(path, 'Bearer garbage', 'GET');
      expect(response.status, path).toBe(401);
    }
    expect(supabase.requests).toEqual([]);
  });
});

describe('the body', () => {
  it('runs on the default input for no body, a blank body and a body without input', async () => {
    const { crawler, owner } = ownCrawler('(input) => input', {
      input_schema: { language: { type: 'string', default: 'ko' }, count: { type: 'number', default: 3 }, skipped: { type: 'string' } },
    });

    for (const body of [undefined, '', '  \n ', '{}', '{"other":1}']) {
      const response = await post(crawler.id, owner, body);
      expect(response, String(body)).toMatchObject({ status: 200, body: { result: { language: 'ko', count: 3 } } });
    }
  });

  it('takes any JSON as the input when the body has one, null and false included', async () => {
    const { crawler, owner } = ownCrawler('(input) => ({ received: input })', { input_schema: { language: { default: 'ko' } } });

    for (const input of [{ a: 1 }, [1, 2], 'text', 5, null, false, 0, '']) {
      const response = await post(crawler.id, owner, { input });
      expect(response.body.result, JSON.stringify(input)).toEqual({ received: input });
    }
  });

  it('answers 400 invalid_request for a body that is not a JSON object, and records nothing', async () => {
    const { crawler, owner } = ownCrawler('(input) => input');

    for (const body of ['not json', '[1,2]', '"text"', '42', 'null', 'true']) {
      const response = await post(crawler.id, owner, body);
      expect(response.status, body).toBe(400);
      expect(response.body.error, body).toBe('invalid_request');
    }
    expect(crawlerRuns()).toEqual([]);
  });

  it('does not need the input schema when the input is given', async () => {
    const { crawler, owner } = ownCrawler('(input) => input', { input_schema: ['not', 'an', 'object'] as unknown as Record<string, unknown> });

    expect((await post(crawler.id, owner)).status).toBe(400);
    expect(await post(crawler.id, owner, { input: 1 })).toMatchObject({ status: 200, body: { result: 1 } });
  });

  it('checks the body before the permission', async () => {
    const { crawler } = ownCrawler('(input) => input');

    const response = await post(crawler.id, uniqueUUID(), 'not json');

    expect(response.status).toBe(400);
  });
});

describe('who may run', () => {
  it('lets the owner and a subscriber run it, answers 404 to a user without a permission, and records the two runs', async () => {
    const { crawler, owner } = ownCrawler('(input) => "ran"');
    const subscriber = uniqueUUID();
    permit(crawler.id, subscriber, 'subscriber');

    expect((await post(crawler.id, owner, { input: {} })).status).toBe(200);
    expect((await post(crawler.id, subscriber, { input: {} })).status).toBe(200);
    const stranger = await post(crawler.id, uniqueUUID(), { input: {} });

    expect(stranger).toMatchObject({ status: 404, body: { error: 'not_found', error_description: 'Crawler not found' } });
    expect(crawlerRuns().map((run) => run.user_uuid).sort()).toEqual([owner, subscriber].sort());
  });

  it('answers 404 and records nothing for a crawler that does not exist', async () => {
    const user = uniqueUUID();
    const missing = uniqueUUID();
    permit(missing, user, 'owner');

    expect((await post(missing, user, { input: {} })).status).toBe(404);
    expect(crawlerRuns()).toEqual([]);
  });

  it('gives the author the values, asking the vault with the token, and hides them in the response and in the record', async () => {
    const { crawler, owner } = ownCrawler(`(input, context) => {
      console.log('using ' + context.environment.SPEECH_API_KEY);
      return { header: 'Bearer ' + context.environment.SPEECH_API_KEY, list: [context.environment.SPEECH_API_KEY] };
    }`);
    await vaultEnvironment(owner, { SPEECH_API_KEY: 'speech-secret-value-0001' });

    const response = await post(crawler.id, owner, { input: {} });

    expect(response.body).toMatchObject({
      status: 'completed',
      result: { header: 'Bearer [REDACTED]', list: ['[REDACTED]'] },
      logs: [{ message: 'using [REDACTED]' }],
    });
    expect(JSON.stringify(response.body)).not.toContain('speech-secret-value-0001');
    expect(JSON.stringify(crawlerRuns())).not.toContain('speech-secret-value-0001');
    expect(await vaultRequests(owner)).toEqual([expect.objectContaining({ route: 'resolve', token: 'test-vault-token', body: { userId: owner } })]);
  });
});

describe('a failed run', () => {
  it('answers 422 execution_failed with the logs, and records the failure with the text of the error', async () => {
    const { crawler, owner } = ownCrawler('(input) => { console.log("before"); throw new Error("boom"); }');

    const response = await post(crawler.id, owner, { input: {} });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      run_id: expect.any(String),
      status: 'failed',
      error: 'execution_failed',
      error_description: 'boom',
      logs: [
        { level: 'log', message: 'before', timestamp: expect.any(String) },
        { level: 'error', message: expect.stringMatching(/^Error: boom/), timestamp: expect.any(String) },
      ],
      logs_truncated: false,
    });
    expect(crawlerRuns()[0]).toMatchObject({
      id: response.body.run_id,
      status: 'failed',
      result: null,
      error_code: 'execution_failed',
      error: 'CodeRunner error 422: [execution_failed] boom',
    });
  });

  it('answers the failure with run_id null when its record cannot be written', async () => {
    const { crawler, owner } = ownCrawler('() => { throw new Error("boom"); }');
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_runs'
      ? { statusCode: 500, data: { message: 'insert failed' } }
      : undefined);

    const response = await post(crawler.id, owner);

    expect(response).toMatchObject({ status: 422, body: { run_id: null, status: 'failed', error: 'execution_failed' } });
  });

  it('answers 503 service_unavailable, recording nothing, for every way the vault can fail', async () => {
    const { crawler, owner } = ownCrawler('() => "never runs"');

    await configureVault(owner, { resolve: { status: 503, body: { error: 'vault_unavailable' } } });
    expect(await post(crawler.id, owner)).toEqual({
      status: 503,
      headers: expect.anything(),
      body: { error: 'service_unavailable', error_description: 'Environment variables could not be read: vault responded 503 vault_unavailable' },
    });

    await configureVault(owner, { resolve: { status: 'unreachable' } });
    expect((await post(crawler.id, owner)).body.error_description).toBe('Environment variables could not be read: vault could not be reached');

    await configureVault(owner, { resolve: { status: 401, body: { error: 'unauthorized' } } });
    expect((await post(crawler.id, owner)).status).toBe(503);

    expect(crawlerRuns()).toEqual([]);
  });

  it('does not log what the code printed or what it failed with', async () => {
    const { crawler, owner } = ownCrawler(`(input, context) => {
      console.log("printed by the crawler: " + context.environment.KEY);
      throw new Error("failure text: " + context.environment.KEY);
    }`);
    await vaultEnvironment(owner, { KEY: SECRET });
    const lines: string[] = [];
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
      });
    }

    const response = await post(crawler.id, owner, { input: {} });
    vi.restoreAllMocks();

    expect(response.status).toBe(422);
    const logged = lines.join('\n');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('printed by the crawler');
    expect(logged).not.toContain('failure text');
    expect(logged).toContain('Crawler run failed');
  });
});

describe('a web crawler', () => {
  const webCrawler = { type: 'web' as const, url_pattern: '.*', input_schema: { body: 'string' }, code: '(body) => body.length' };

  it.each([401, 403, 404, 413, 429])('answers 502 execution_error for an answer %i of the Lambda', async (status) => {
    const { crawler, owner } = ownCrawler(webCrawler.code, webCrawler);
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' }).reply(status, JSON.stringify({ message: 'x' }));

    const response = await post(crawler.id, owner, { input: { url: 'https://www.example.com/page' } });

    expect(response).toMatchObject({ status: 502, body: { status: 'failed', error: 'execution_error' } });
    expect(crawlerRuns()[0]).toMatchObject({ status: 'failed', error_code: 'execution_error' });
  });

  it('answers 502 invalid_response when the Lambda does not answer a string', async () => {
    const { crawler, owner } = ownCrawler(webCrawler.code, webCrawler);
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' })
      .reply(200, JSON.stringify({ type: 'web', mode: 'run', result: { not: 'a string' } }));

    const response = await post(crawler.id, owner, { input: { url: 'https://www.example.com/page' } });

    expect(response).toMatchObject({ status: 502, body: { error: 'invalid_response', error_description: 'Expected the page body as a string' } });
  });

  it('asks the Lambda three times for a 5xx, and takes the status of its answer from the text of the error', async () => {
    const { crawler, owner } = ownCrawler(webCrawler.code, webCrawler);
    let asked = 0;
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' })
      .reply(() => {
        asked += 1;
        return { statusCode: 504, data: JSON.stringify({ error: 'fetch_timeout', error_description: 'Fetch timed out after 10000ms' }) };
      })
      .times(3);

    const response = await post(crawler.id, owner, { input: { url: 'https://slow.example.com/' } });

    expect(asked).toBe(3);
    // The client keeps the 5xx as server_error; the status follows the number in the error text (design, section 4)
    expect(response).toMatchObject({ status: 504, body: { status: 'failed', error: 'server_error', error_description: 'Server returned 504' } });
  }, 20_000);

  it('asks the Lambda three times for a 503 too, and answers 502', async () => {
    const { crawler, owner } = ownCrawler(webCrawler.code, webCrawler);
    let asked = 0;
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' })
      .reply(() => {
        asked += 1;
        return { statusCode: 503, data: '{}' };
      })
      .times(3);

    const response = await post(crawler.id, owner, { input: { url: 'https://www.example.com/page' } });

    expect(asked).toBe(3);
    expect(response).toMatchObject({ status: 502, body: { error: 'server_error' } });
  }, 20_000);
});

describe('the files of a direct run', () => {
  it('keeps a saved file for 24 hours, owned by the user and tied to no scheduler run', async () => {
    const { crawler, owner } = ownCrawler('async (input, context) => ({ audio: await context.files.save("sound", { name: "a.mp3", contentType: "audio/mpeg" }) })');

    const response = await post(crawler.id, owner, { input: {} });

    expect(response.body.result.audio).toEqual({ file_id: expect.any(String), name: 'a.mp3', content_type: 'audio/mpeg', size: 5 });
    const row = (supabase.tables.crawler_files ?? [])[0];
    expect(row).toMatchObject({ user_uuid: owner, crawler_id: crawler.id, run_id: null });
    const hours = (Date.parse(String(row.expires_at)) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });
});

describe('a result with NUL characters', () => {
  it('answers the result as it is with run_id null when the database refuses the record, as Postgres JSONB does', async () => {
    const { crawler, owner } = ownCrawler('() => ({ text: "a\\u0000b" })');
    // Postgres refuses \u0000 in JSONB; the stand-in database does not, so it is told to
    supabase.intercept = (request) => (request.method === 'POST' && request.table === 'crawler_runs' && JSON.stringify(request.body).includes('\\u0000')
      ? { statusCode: 400, data: { code: '22P05', message: 'unsupported Unicode escape sequence' } }
      : undefined);

    const response = await post(crawler.id, owner, { input: {} });

    expect(response).toMatchObject({ status: 200, body: { run_id: null, status: 'completed', result: { text: 'a\u0000b' } } });
    expect(crawlerRuns()).toEqual([]);
  });
});

describe('methods and paths', () => {
  it('answers 405 to a method other than POST on the runs path, and other than GET on a run', async () => {
    const { crawler, owner } = ownCrawler('(input) => input');
    const created = await post(crawler.id, owner);
    const runID = created.body.run_id as string;

    for (const method of ['GET', 'PUT', 'DELETE']) {
      const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs`, { method, userUUID: owner }));
      await response.text();
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toContain('POST');
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs/${runID}`, { method, userUUID: owner }));
      await response.text();
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toContain('GET');
    }
  });

  it('answers 404 for a crawler ID that is not a UUID, on the runs path', async () => {
    expect((await post('abc', uniqueUUID(), { input: {} })).status).toBe(404);
  });

  it('keeps the routes of the crawlers as they were', async () => {
    const { crawler, owner } = ownCrawler('(input) => input');

    const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}`, { userUUID: owner }));

    expect(response.status).toBe(200);
    expect((await response.json() as { id: string }).id).toBe(crawler.id);
  });
});

describe('the record of a run', () => {
  it('is the whole row of the run, and only the user who ran it may read it', async () => {
    const { crawler, owner } = ownCrawler('(input) => { console.log("one"); return { v: 1 }; }');
    const subscriber = uniqueUUID();
    permit(crawler.id, subscriber, 'subscriber');
    const created = await post(crawler.id, owner, { input: {} });
    const runID = created.body.run_id as string;

    const own = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs/${runID}`, { userUUID: owner }));
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      id: runID,
      user_uuid: owner,
      crawler_id: crawler.id,
      status: 'completed',
      result: { v: 1 },
      error_code: null,
      error: null,
      logs: [{ level: 'log', message: 'one', timestamp: expect.any(String) }],
      logs_truncated: false,
      started_at: expect.any(String),
      completed_at: expect.any(String),
      created_at: expect.any(String),
    });

    // A subscriber may run the crawler but not read the record of another user's run
    const other = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs/${runID}`, { userUUID: subscriber }));
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not_found', error_description: 'Crawler run not found' });
  });

  it('answers 404 for a run id with a character added', async () => {
    const { crawler, owner } = ownCrawler('(input) => 1');
    const created = await post(crawler.id, owner);

    const response = await SELF.fetch(await workerRequest(`/crawlers/${crawler.id}/runs/${created.body.run_id}x`, { userUUID: owner }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found', error_description: 'Crawler run not found' });
  });
});
