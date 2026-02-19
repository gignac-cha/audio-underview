import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';
const MOCK_USER_UUID = '00000000-0000-0000-0000-000000000001';
const MOCK_CRAWLER_ID = '00000000-0000-0000-0000-000000000099';
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

function validCrawlerBody() {
  return { name: 'Test Crawler', url_pattern: '.*\\.example\\.com', code: '(text) => text' };
}

function mockCrawlerResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_CRAWLER_ID,
    user_uuid: MOCK_USER_UUID,
    name: 'Test Crawler',
    url_pattern: '.*\\.example\\.com',
    code: '(text) => text',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockSupabaseCrawlerCreate(overrides: Record<string, unknown> = {}) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'POST' })
    .reply(201, JSON.stringify(mockCrawlerResponse(overrides)));
}

function mockSupabaseCrawlerList(data: unknown[] = [mockCrawlerResponse()], total: number = 1) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
    .reply(200, JSON.stringify(data), { headers: { 'content-range': data.length > 0 ? `0-${data.length - 1}/${total}` : `*/${total}` } });
}

function mockSupabaseCrawlerGet(data: unknown = mockCrawlerResponse()) {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
    .reply(200, JSON.stringify(data));
}

function mockSupabaseCrawlerNotFound() {
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
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

describe('crawler-manager-worker', () => {
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

    it('returns 204 without CORS origin header for unknown origin', async () => {
      const request = new Request(WORKER_URL, {
        method: 'OPTIONS',
        headers: { Origin: 'https://unknown.example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
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
      expect(body.name).toBe('crawler-manager-worker');
      expect(body.endpoints).toBeDefined();
      expect(body.endpoints.length).toBeGreaterThan(0);
    });

    it('returns help JSON on GET /help', async () => {
      const request = new Request(`${WORKER_URL}/help`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('crawler-manager-worker');
    });

    it('includes /auth/token in help endpoints', async () => {
      const request = new Request(WORKER_URL, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      const body = await response.json();
      const tokenEndpoint = body.endpoints.find((endpoint: { path: string }) => endpoint.path === '/auth/token');
      expect(tokenEndpoint).toBeDefined();
      expect(tokenEndpoint.method).toBe('POST');
    });
  });

  describe('authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const request = new Request(`${WORKER_URL}/crawlers`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when token is invalid', async () => {
      const request = new Request(`${WORKER_URL}/crawlers`, {
        headers: {
          Origin: 'https://example.com',
          Authorization: 'Bearer invalid-token',
        },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when JWT is expired', async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredToken = await signJWT(
        { sub: MOCK_USER_UUID, iat: now - 7200, exp: now - 3600 },
        JWT_SECRET,
      );

      const request = new Request(`${WORKER_URL}/crawlers`, {
        headers: {
          Origin: 'https://example.com',
          Authorization: `Bearer ${expiredToken}`,
        },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });

    it('returns 401 when JWT is signed with wrong secret', async () => {
      const now = Math.floor(Date.now() / 1000);
      const wrongSecretToken = await signJWT(
        { sub: MOCK_USER_UUID, iat: now, exp: now + 86400 },
        'wrong-secret',
      );

      const request = new Request(`${WORKER_URL}/crawlers`, {
        headers: {
          Origin: 'https://example.com',
          Authorization: `Bearer ${wrongSecretToken}`,
        },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/token', () => {
    it('returns a JWT for valid Google token', async () => {
      fetchMock
        .get('https://www.googleapis.com')
        .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
        .reply(200, JSON.stringify({ sub: 'google-sub-123', email: 'test@example.com' }));

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/accounts/, method: 'GET' })
        .reply(200, JSON.stringify({ provider: 'google', identifier: 'google-sub-123', uuid: MOCK_USER_UUID }));

      const request = new Request(`${WORKER_URL}/auth/token`, {
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

    it('returns a JWT for valid GitHub token', async () => {
      fetchMock
        .get('https://api.github.com')
        .intercept({ path: '/user', method: 'GET' })
        .reply(200, JSON.stringify({ id: 12345, login: 'testuser' }));

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/accounts/, method: 'GET' })
        .reply(200, JSON.stringify({ provider: 'github', identifier: '12345', uuid: MOCK_USER_UUID }));

      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'github', access_token: 'valid-github-token' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
    });

    it('returns 400 for missing provider', async () => {
      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ access_token: 'some-token' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 for invalid provider', async () => {
      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'twitter', access_token: 'some-token' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing access_token', async () => {
      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('returns 400 for non-JSON body', async () => {
      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
        },
        body: 'not json',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('returns 401 when provider rejects the token', async () => {
      fetchMock
        .get('https://www.googleapis.com')
        .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
        .reply(401, JSON.stringify({ error: 'invalid_token' }));

      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google', access_token: 'bad-token' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });

    it('returns 401 when no account exists for the provider user', async () => {
      fetchMock
        .get('https://www.googleapis.com')
        .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
        .reply(200, JSON.stringify({ sub: 'unknown-sub' }));

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/accounts/, method: 'GET' })
        .reply(406, JSON.stringify({
          code: 'PGRST116',
          details: 'The result contains 0 rows',
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        }));

      const request = new Request(`${WORKER_URL}/auth/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google', access_token: 'valid-but-unregistered' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /crawlers validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        body: 'not json',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('JSON');
    });

    it('returns 400 for missing name', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url_pattern: '.*', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('name');
    });

    it('returns 400 for whitespace-only name', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ', url_pattern: '.*', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('name');
    });

    it('returns 400 when name exceeds max length', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x'.repeat(256), url_pattern: '.*', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('255');
    });

    it('returns 400 for invalid regex in url_pattern', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', url_pattern: '(((', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('regex');
    });

    it('rejects ReDoS-prone regex in url_pattern', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        body: JSON.stringify({ name: 'test', url_pattern: '(a+)+', code: '(x) => x' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error_description).toContain('unsafe regex pattern');
    });
  });

  describe('POST /crawlers success', () => {
    it('creates a crawler and returns 201', async () => {
      const crawlerData = validCrawlerBody();
      mockSupabaseCrawlerCreate(crawlerData);

      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(crawlerData),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Test Crawler');
      expect(body.id).toBe(MOCK_CRAWLER_ID);
    });
  });

  describe('GET /crawlers', () => {
    it('lists crawlers for the authenticated user', async () => {
      mockSupabaseCrawlerList();

      const request = await authenticatedRequest('/crawlers');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBe(1);
      expect(body.total).toBe(1);
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(20);
    });

    it('accepts valid offset and limit query parameters', async () => {
      mockSupabaseCrawlerList();

      const request = await authenticatedRequest('/crawlers?offset=0&limit=10');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(10);
    });

    it('returns 400 for negative offset', async () => {
      const request = await authenticatedRequest('/crawlers?offset=-1');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('offset');
    });

    it('returns 400 for zero limit', async () => {
      const request = await authenticatedRequest('/crawlers?limit=0');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('limit');
    });

    it('returns 400 for limit exceeding maximum', async () => {
      const request = await authenticatedRequest('/crawlers?limit=101');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('limit');
    });

    it('returns 400 for non-numeric offset', async () => {
      const request = await authenticatedRequest('/crawlers?offset=abc');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('offset');
    });

    it('returns 400 for non-integer limit', async () => {
      const request = await authenticatedRequest('/crawlers?limit=1.5');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('limit');
    });
  });

  describe('GET /crawlers/:id', () => {
    it('returns a crawler by ID', async () => {
      mockSupabaseCrawlerGet();

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(MOCK_CRAWLER_ID);
    });

    it('returns 404 when crawler belongs to another user', async () => {
      mockSupabaseCrawlerNotFound();

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /crawlers/:id validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        body: 'not json',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('JSON');
    });

    it('returns 400 for missing fields', async () => {
      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /crawlers/:id success', () => {
    it('updates a crawler and returns 200', async () => {
      const updatedData = { name: 'Updated Crawler', url_pattern: '.*', code: '(x) => x.toUpperCase()' };
      const mockResponse = mockCrawlerResponse(updatedData);

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'PATCH' })
        .reply(200, JSON.stringify(mockResponse));

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedData),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('Updated Crawler');
    });

    it('returns 404 when crawler does not exist or belongs to another user', async () => {
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'PATCH' })
        .reply(406, JSON.stringify({
          code: 'PGRST116',
          details: 'The result contains 0 rows',
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        }));

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCrawlerBody()),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /crawlers/:id', () => {
    it('deletes a crawler and returns 200', async () => {
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'DELETE' })
        .reply(200, JSON.stringify([mockCrawlerResponse()]));

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 when crawler belongs to another user', async () => {
      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'DELETE' })
        .reply(200, JSON.stringify([]));

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
    });
  });

  describe('invalid UUID format', () => {
    it('returns 404 for invalid crawler ID in GET', async () => {
      const request = await authenticatedRequest('/crawlers/abc');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });

    it('returns 404 for invalid crawler ID in PUT', async () => {
      const request = await authenticatedRequest('/crawlers/abc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCrawlerBody()),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });

    it('returns 404 for invalid crawler ID in DELETE', async () => {
      const request = await authenticatedRequest('/crawlers/abc', {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const request = new Request(`${WORKER_URL}/unknown`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
    });
  });
});
