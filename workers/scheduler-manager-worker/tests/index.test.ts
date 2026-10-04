import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';
const MOCK_USER_UUID = '00000000-0000-0000-0000-000000000001';
const MOCK_SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const MOCK_STAGE_ID = '00000000-0000-0000-0000-000000000020';
const MOCK_CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const MOCK_RUN_ID = '00000000-0000-0000-0000-000000000040';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

async function createTestJWT(userUUID: string = MOCK_USER_UUID): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ sub: userUUID, iat: now, exp: now + 86400 }, JWT_SECRET);
}

async function authenticatedRequest(path: string, options: RequestInit = {}): Promise<Request> {
  const token = await createTestJWT();
  const headers = new Headers(options.headers);
  headers.set('Origin', 'https://example.com');
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(`${WORKER_URL}${path}`, { ...options, headers });
}

function mockSchedulerResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_SCHEDULER_ID,
    user_uuid: MOCK_USER_UUID,
    name: 'Test Scheduler',
    cron_expression: null,
    timezone: 'Asia/Seoul',
    is_enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockStageResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_STAGE_ID,
    scheduler_id: MOCK_SCHEDULER_ID,
    crawler_id: MOCK_CRAWLER_ID,
    stage_order: 0,
    input_schema: { url: { type: 'string', default: 'https://example.com' } },
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockRunResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_RUN_ID,
    scheduler_id: MOCK_SCHEDULER_ID,
    status: 'pending',
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockSupabaseSchedulerCreate(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'POST' })
    .reply(201, JSON.stringify(mockSchedulerResponse(overrides)));
}

interface CapturedRequestBody {
  body: Record<string, unknown> | undefined;
}

function captureSupabaseSchedulerCreate(): CapturedRequestBody {
  const captured: CapturedRequestBody = { body: undefined };
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'POST' })
    .reply((options) => {
      captured.body = JSON.parse(String(options.body)) as Record<string, unknown>;
      return { statusCode: 201, data: JSON.stringify(mockSchedulerResponse(captured.body)) };
    });
  return captured;
}

function captureSupabaseSchedulerUpdate(current: Record<string, unknown> = {}): CapturedRequestBody {
  const captured: CapturedRequestBody = { body: undefined };
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'PATCH' })
    .reply((options) => {
      captured.body = JSON.parse(String(options.body)) as Record<string, unknown>;
      return { statusCode: 200, data: JSON.stringify(mockSchedulerResponse({ ...current, ...captured.body })) };
    });
  return captured;
}

function mockSupabaseSchedulerList(data: unknown[] = [mockSchedulerResponse()], total: number = 1) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'GET' })
    .reply(200, JSON.stringify(data), {
      headers: { 'content-range': data.length > 0 ? `0-${data.length - 1}/${total}` : `*/${total}` },
    });
}

function mockSupabaseSchedulerGet(data: unknown = mockSchedulerResponse()) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'GET' })
    .reply(200, JSON.stringify(data));
}

function mockCrawlerPermission() {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/crawler_permissions/, method: 'GET' })
    .reply(200, JSON.stringify({
      id: '00000000-0000-0000-0000-000000000099',
      crawler_id: MOCK_CRAWLER_ID,
      user_uuid: MOCK_USER_UUID,
      level: 'owner',
      created_at: '2026-01-01T00:00:00Z',
    }));
}

function mockSupabaseSchedulerNotFound() {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'GET' })
    .reply(406, JSON.stringify({
      code: 'PGRST116',
      details: 'The result contains 0 rows',
      hint: null,
      message: 'JSON object requested, multiple (or no) rows returned',
    }));
}

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('scheduler-manager-worker', () => {
  describe('OPTIONS preflight', () => {
    it('returns 204 with CORS headers for allowed origin', async () => {
      const request = new Request(WORKER_URL, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    });
  });

  describe('HEAD request', () => {
    it('returns 200 with Content-Type header and no body', async () => {
      const request = new Request(WORKER_URL, {
        method: 'HEAD',
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      expect(response.body).toBeNull();
    });
  });

  describe('GET / and GET /help', () => {
    it('returns help JSON on GET /', async () => {
      const request = new Request(WORKER_URL, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('scheduler-manager-worker');
      expect(body.endpoints).toBeDefined();
      expect(body.endpoints.length).toBeGreaterThan(0);
    });

    it('includes /authentication/token in help endpoints', async () => {
      const request = new Request(WORKER_URL, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      const body = await response.json();
      const tokenEndpoint = body.endpoints.find((endpoint: { path: string }) => endpoint.path === '/authentication/token');
      expect(tokenEndpoint).toBeDefined();
      expect(tokenEndpoint.method).toBe('POST');
    });
  });

  describe('authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const request = new Request(`${WORKER_URL}/schedulers`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when token is invalid', async () => {
      const request = new Request(`${WORKER_URL}/schedulers`, {
        headers: {
          Origin: 'https://example.com',
          Authorization: 'Bearer invalid-token',
        },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /authentication/token', () => {
    it('returns a JWT for valid Google token', async () => {
      fetchMock
        .get('https://www.googleapis.com')
        .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
        .reply(200, JSON.stringify({ sub: 'google-sub-123', email: 'test@example.com' }));

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/accounts/, method: 'GET' })
        .reply(200, JSON.stringify({ provider: 'google', identifier: 'google-sub-123', uuid: MOCK_USER_UUID }));

      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google', access_token: 'valid-google-token' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(86400);
    });

    it('returns 400 for missing provider', async () => {
      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: 'some-token' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('returns 405 for GET /authentication/token', async () => {
      const request = new Request(`${WORKER_URL}/authentication/token`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(405);
    });
  });

  describe('POST /schedulers', () => {
    it('creates a scheduler and returns 201', async () => {
      mockSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Test Scheduler');
      expect(body.id).toBe(MOCK_SCHEDULER_ID);
    });

    it('returns 400 for missing name', async () => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('name');
    });

    it('returns 400 for non-JSON body', async () => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        body: 'not json',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('returns 400 when timezone is not a string', async () => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', timezone: 9 }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must be a string");
    });

    it('returns 400 when timezone is not a valid IANA time zone', async () => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', timezone: 'Not/AZone' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must be a valid IANA time zone");
    });

    it('returns 400 when the timezone UTC offset is not a multiple of 10 minutes', async () => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 7 * * *', timezone: 'Asia/Kathmandu' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must have a UTC offset in whole multiples of 10 minutes");
    });

    it.each([
      { label: 'Pacific/Chatham (+12:45/+13:45)', timezone: 'Pacific/Chatham' },
      { label: 'Australia/Eucla (+8:45)', timezone: 'Australia/Eucla' },
    ])('returns 400 for $label, whose UTC offset is not a multiple of 10 minutes', async ({ timezone }) => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 7 * * *', timezone }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must have a UTC offset in whole multiples of 10 minutes");
    });

    it('stores a timezone whose UTC offset changes on the 10-minute grid', async () => {
      const captured = captureSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 7 * * *', timezone: 'America/New_York' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      expect(captured.body!.timezone).toBe('America/New_York');
      // 07:00 in New York is 11:00 UTC in summer and 12:00 UTC in winter.
      expect(captured.body!.next_run_at).toMatch(/T1[12]:00:00\.000Z$/);
    });

    it('returns 400 when the cron minute is not a 10-minute value', async () => {
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '5 9 * * *' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'cron_expression' minute must be 0, 10, 20, 30, 40 or 50");
    });

    it('returns 400 when the cron expression has no next run', async () => {
      // February 31 passes the field format check but never occurs.
      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 0 31 2 *' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'cron_expression' must be a valid cron expression");
    });

    it('stores the default timezone and the next run for a cron expression', async () => {
      const captured = captureSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 7 * * *' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      expect(captured.body).toBeDefined();
      expect(captured.body!.timezone).toBe('Asia/Seoul');
      expect(captured.body!.next_run_at).not.toBeNull();
      // 07:00 in Asia/Seoul is 22:00 UTC on the previous day.
      expect(captured.body!.next_run_at).toMatch(/T22:00:00\.000Z$/);
      expect(new Date(captured.body!.next_run_at as string).getTime()).toBeGreaterThan(Date.now());
    });

    it('stores the requested timezone and evaluates the cron expression in it', async () => {
      const captured = captureSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 7 * * *', timezone: 'UTC' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      expect(captured.body!.timezone).toBe('UTC');
      expect(captured.body!.next_run_at).toMatch(/T07:00:00\.000Z$/);
    });

    it('stores next_run_at null when there is no cron expression', async () => {
      const captured = captureSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      expect(captured.body!.timezone).toBe('Asia/Seoul');
      expect(captured.body!.next_run_at).toBeNull();
    });

    it('stores next_run_at null when created disabled', async () => {
      const captured = captureSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', cron_expression: '0 7 * * *', is_enabled: false }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      expect(captured.body!.next_run_at).toBeNull();
    });

    it('ignores next_run_at in the request body', async () => {
      const captured = captureSupabaseSchedulerCreate();

      const request = await authenticatedRequest('/schedulers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test Scheduler', next_run_at: '2026-10-05T22:00:00.000Z' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      expect(captured.body!.next_run_at).toBeNull();
    });
  });

  describe('GET /schedulers', () => {
    it('lists schedulers for the authenticated user', async () => {
      mockSupabaseSchedulerList();

      const request = await authenticatedRequest('/schedulers');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.total).toBe(1);
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(20);
    });
  });

  describe('GET /schedulers/:id', () => {
    it('returns a scheduler by ID', async () => {
      mockSupabaseSchedulerGet();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(MOCK_SCHEDULER_ID);
    });

    it('returns 404 when scheduler not found', async () => {
      mockSupabaseSchedulerNotFound();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /schedulers/:id', () => {
    it('updates a scheduler and returns 200', async () => {
      const updatedData = { name: 'Updated Scheduler' };
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'PATCH' })
        .reply(200, JSON.stringify(mockSchedulerResponse(updatedData)));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedData),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('Updated Scheduler');
    });

    it('returns 404 when scheduler does not exist', async () => {
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'PATCH' })
        .reply(406, JSON.stringify({
          code: 'PGRST116',
          details: 'The result contains 0 rows',
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        }));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });

    it('sets next_run_at to null when the scheduler is disabled', async () => {
      const current = { cron_expression: '0 7 * * *', next_run_at: '2026-10-05T22:00:00.000Z' };
      mockSupabaseSchedulerGet(mockSchedulerResponse(current));
      const captured = captureSupabaseSchedulerUpdate(current);

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: false }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(captured.body).toEqual({ is_enabled: false, next_run_at: null });
    });

    it('recomputes next_run_at from the current cron expression when only timezone changes', async () => {
      const current = { cron_expression: '0 7 * * *', timezone: 'Asia/Seoul' };
      mockSupabaseSchedulerGet(mockSchedulerResponse(current));
      const captured = captureSupabaseSchedulerUpdate(current);

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: 'UTC' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(captured.body).toBeDefined();
      expect(Object.keys(captured.body!).sort()).toEqual(['next_run_at', 'timezone']);
      expect(captured.body!.timezone).toBe('UTC');
      // The stored 07:00 now means 07:00 UTC.
      expect(captured.body!.next_run_at).toMatch(/T07:00:00\.000Z$/);
    });

    it('does not read the current row or send next_run_at when only name changes', async () => {
      // Only the PATCH is mocked and net connect is disabled, so reading the current row would fail the request.
      const captured = captureSupabaseSchedulerUpdate();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated Scheduler' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(captured.body).toEqual({ name: 'Updated Scheduler' });
    });

    it('returns 404 when the current row is missing', async () => {
      mockSupabaseSchedulerNotFound();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: false }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
      expect(body.error_description).toBe('Scheduler not found or not owned by you');
    });

    it('returns 400 when timezone is null', async () => {
      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: null }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must be a string");
    });

    it('returns 400 when the timezone UTC offset is not a multiple of 10 minutes', async () => {
      // Nothing is mocked and net connect is disabled, so the request is rejected before any read.
      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: 'Asia/Kathmandu' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must have a UTC offset in whole multiples of 10 minutes");
    });

    it.each([
      { label: 'Pacific/Chatham (+12:45/+13:45)', timezone: 'Pacific/Chatham' },
      { label: 'Australia/Eucla (+8:45)', timezone: 'Australia/Eucla' },
    ])('returns 400 for $label, whose UTC offset is not a multiple of 10 minutes', async ({ timezone }) => {
      // Nothing is mocked and net connect is disabled, so the request is rejected before any read.
      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'timezone' must have a UTC offset in whole multiples of 10 minutes");
    });

    it('returns 400 when the cron minute is not a 10-minute value', async () => {
      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron_expression: '5 9 * * *' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toBe("Field 'cron_expression' minute must be 0, 10, 20, 30, 40 or 50");
    });

    it('returns 400 when the cron expression has no next run in the stored timezone', async () => {
      mockSupabaseSchedulerGet(mockSchedulerResponse({ cron_expression: '0 7 * * *' }));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cron_expression: '0 0 31 2 *' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toBe("Field 'cron_expression' must be a valid cron expression");
    });
  });

  describe('DELETE /schedulers/:id', () => {
    it('deletes a scheduler and returns 200', async () => {
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'DELETE' })
        .reply(200, JSON.stringify([mockSchedulerResponse()]));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 when scheduler not found', async () => {
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/schedulers/, method: 'DELETE' })
        .reply(200, JSON.stringify([]));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}`, {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /schedulers/:id/stages', () => {
    it('creates a stage and returns 201', async () => {
      // Mock scheduler ownership check
      mockSupabaseSchedulerGet();
      // Mock crawler permission check
      mockCrawlerPermission();
      // Mock stage creation
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/scheduler_stages/, method: 'POST' })
        .reply(201, JSON.stringify(mockStageResponse()));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          crawler_id: MOCK_CRAWLER_ID,
          stage_order: 0,
          input_schema: { url: { type: 'string', default: 'https://example.com' } },
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.crawler_id).toBe(MOCK_CRAWLER_ID);
      expect(body.stage_order).toBe(0);
      expect(body.input_schema).toBeDefined();
    });

    it('returns 400 for missing crawler_id', async () => {
      mockSupabaseSchedulerGet();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_order: 0 }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('crawler_id');
    });

    it('returns 404 when scheduler not found', async () => {
      mockSupabaseSchedulerNotFound();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          crawler_id: MOCK_CRAWLER_ID,
          stage_order: 0,
          input_schema: { url: { type: 'string' } },
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /schedulers/:id/stages', () => {
    it('lists stages for a scheduler', async () => {
      mockSupabaseSchedulerGet();
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/scheduler_stages/, method: 'GET' })
        .reply(200, JSON.stringify([mockStageResponse()]));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  describe('GET /schedulers/:id/runs', () => {
    it('lists runs for a scheduler', async () => {
      mockSupabaseSchedulerGet();
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/scheduler_runs/, method: 'GET' })
        .reply(200, JSON.stringify([mockRunResponse()]), {
          headers: { 'content-range': '0-0/1' },
        });

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/runs`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(body.total).toBe(1);
    });
  });

  describe('GET /schedulers/:id/runs/:runID', () => {
    it('returns a run by ID', async () => {
      mockSupabaseSchedulerGet();
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/scheduler_runs/, method: 'GET' })
        .reply(200, JSON.stringify(mockRunResponse()));
      // The stage runs of the run, without their input and output
      const stageRuns = [{ id: '00000000-0000-0000-0000-000000000050', run_id: MOCK_RUN_ID, stage_order: 0, status: 'running', progress: null }];
      let stageRunsPath = '';
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/scheduler_stage_runs/, method: 'GET' })
        .reply((options) => {
          stageRunsPath = decodeURIComponent(String(options.path));
          return { statusCode: 200, data: JSON.stringify(stageRuns) };
        });

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/runs/${MOCK_RUN_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(MOCK_RUN_ID);
      expect(body.stage_runs).toEqual(stageRuns);
      expect(stageRunsPath).toContain(`run_id=eq.${MOCK_RUN_ID}`);
      expect(stageRunsPath).toContain('order=stage_order.asc');
      expect(new URLSearchParams(stageRunsPath.slice(stageRunsPath.indexOf('?') + 1)).get('select')?.split(',')).not.toContain('input');
    });
  });

  describe('PUT /schedulers/:id/stages/reorder', () => {
    it('reorders stages and returns 200', async () => {
      mockSupabaseSchedulerGet();
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/rpc\/reorder_scheduler_stages/, method: 'POST' })
        .reply(200, JSON.stringify([
          mockStageResponse({ id: MOCK_STAGE_ID, stage_order: 0 }),
          mockStageResponse({ id: '00000000-0000-0000-0000-000000000021', stage_order: 1 }),
        ]));

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage_ids: [MOCK_STAGE_ID, '00000000-0000-0000-0000-000000000021'],
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(2);
    });

    it('returns 400 for missing stage_ids', async () => {
      mockSupabaseSchedulerGet();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('stage_ids');
    });

    it('returns 400 for empty stage_ids array', async () => {
      mockSupabaseSchedulerGet();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_ids: [] }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid UUID in stage_ids', async () => {
      mockSupabaseSchedulerGet();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_ids: ['not-a-uuid'] }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('UUID');
    });

    it('returns 400 for duplicate stage_ids', async () => {
      mockSupabaseSchedulerGet();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_ids: [MOCK_STAGE_ID, MOCK_STAGE_ID] }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('duplicate');
    });

    it('returns 404 when scheduler not found', async () => {
      mockSupabaseSchedulerNotFound();

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_ids: [MOCK_STAGE_ID] }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });

    it('returns 405 for GET method', async () => {
      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/stages/reorder`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('PUT');
    });
  });

  describe('invalid routes', () => {
    it('returns 404 for invalid UUID format', async () => {
      const request = await authenticatedRequest('/schedulers/abc');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });

    it('returns 404 for unknown path', async () => {
      const request = new Request(`${WORKER_URL}/unknown`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });
});
