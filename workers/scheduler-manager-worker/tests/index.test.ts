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
    is_enabled: true,
    last_run_at: null,
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

      const request = await authenticatedRequest(`/schedulers/${MOCK_SCHEDULER_ID}/runs/${MOCK_RUN_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(MOCK_RUN_ID);
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
