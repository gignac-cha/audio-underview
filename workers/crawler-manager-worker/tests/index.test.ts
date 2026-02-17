import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';
const MOCK_USER_UUID = '00000000-0000-0000-0000-000000000001';
const MOCK_CRAWLER_ID = '00000000-0000-0000-0000-000000000099';
const VALID_TOKEN = 'valid-google-token';

function mockAuthentication() {
  fetchMock
    .get('https://www.googleapis.com')
    .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
    .reply(200, JSON.stringify({ sub: 'google-sub-123', email: 'test@example.com' }));

  fetchMock
    .get('https://supabase.example.com')
    .intercept({
      path: /^\/rest\/v1\/accounts/,
      method: 'GET',
    })
    .reply(200, JSON.stringify({ provider: 'google', identifier: 'google-sub-123', uuid: MOCK_USER_UUID }));
}

function mockAuthenticationFailure() {
  fetchMock
    .get('https://www.googleapis.com')
    .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
    .reply(401, JSON.stringify({ error: 'invalid_token' }));
}

function authenticatedRequest(path: string, options: RequestInit = {}): Request {
  const headers = new Headers(options.headers);
  headers.set('Origin', 'https://example.com');
  headers.set('Authorization', `Bearer ${VALID_TOKEN}`);
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
      mockAuthenticationFailure();

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
  });

  describe('POST /crawlers validation', () => {
    it('returns 400 for non-JSON body', async () => {
      mockAuthentication();

      const request = authenticatedRequest('/crawlers', {
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
      mockAuthentication();

      const request = authenticatedRequest('/crawlers', {
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
      mockAuthentication();

      const request = authenticatedRequest('/crawlers', {
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
      mockAuthentication();

      const request = authenticatedRequest('/crawlers', {
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
      mockAuthentication();

      const request = authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', url_pattern: '(((', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('regex');
    });
  });

  describe('POST /crawlers success', () => {
    it('creates a crawler and returns 201', async () => {
      mockAuthentication();

      const crawlerData = validCrawlerBody();
      const mockResponse = mockCrawlerResponse(crawlerData);

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'POST' })
        .reply(201, JSON.stringify(mockResponse));

      const request = authenticatedRequest('/crawlers', {
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
      mockAuthentication();

      const mockList = [mockCrawlerResponse()];

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
        .reply(200, JSON.stringify(mockList));

      const request = authenticatedRequest('/crawlers');
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(1);
    });
  });

  describe('GET /crawlers/:id', () => {
    it('returns a crawler by ID', async () => {
      mockAuthentication();

      const mockData = mockCrawlerResponse();

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
        .reply(200, JSON.stringify(mockData));

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(MOCK_CRAWLER_ID);
    });

    it('returns 404 when crawler belongs to another user', async () => {
      mockAuthentication();

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
        .reply(406, JSON.stringify({
          code: 'PGRST116',
          details: 'The result contains 0 rows',
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        }));

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /crawlers/:id validation', () => {
    it('returns 400 for non-JSON body', async () => {
      mockAuthentication();

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        body: 'not json',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error_description).toContain('JSON');
    });

    it('returns 400 for missing fields', async () => {
      mockAuthentication();

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
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
      mockAuthentication();

      const updatedData = { name: 'Updated Crawler', url_pattern: '.*', code: '(x) => x.toUpperCase()' };
      const mockResponse = mockCrawlerResponse(updatedData);

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'PATCH' })
        .reply(200, JSON.stringify(mockResponse));

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedData),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('Updated Crawler');
    });
  });

  describe('DELETE /crawlers/:id', () => {
    it('deletes a crawler and returns 200', async () => {
      mockAuthentication();

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'DELETE' })
        .reply(200, JSON.stringify([mockCrawlerResponse()]));

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 when crawler belongs to another user', async () => {
      mockAuthentication();

      fetchMock
        .get('https://supabase.example.com')
        .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'DELETE' })
        .reply(200, JSON.stringify([]));

      const request = authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'DELETE',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
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
