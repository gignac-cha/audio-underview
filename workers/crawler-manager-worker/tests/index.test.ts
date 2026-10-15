import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { exports } from 'cloudflare:workers';
import { env, SELF } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import { SYSTEM_USER_UUID } from '@audio-underview/supabase-connector';
import type CrawlerManagerWorker from '../sources/index.ts';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { appendHandlers, network, requestMatching } from '@audio-underview/worker-tools/tests/network.ts';

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

function validDataCrawlerBody() {
  return {
    name: 'Data Crawler',
    type: 'data' as const,
    code: '(data) => data',
    input_schema: { items: 'array' },
  };
}

function mockCrawlerResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: MOCK_CRAWLER_ID,
    user_uuid: MOCK_USER_UUID,
    name: 'Test Crawler',
    type: 'web',
    url_pattern: '.*\\.example\\.com',
    code: '(text) => text',
    input_schema: { body: 'string' },
    output_schema: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockSupabaseCrawlerCreate(overrides: Record<string, unknown> = {}) {
  const crawlerResponse = mockCrawlerResponse(overrides);
  appendHandlers(
    network,
    http.all(
      requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'POST' }),
      () => HttpResponse.json(crawlerResponse, { status: 201 }),
      { once: true },
    ),
  );
  appendHandlers(
    network,
    http.all(
      requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawler_permissions/, method: 'POST' }),
      () => HttpResponse.json({
        id: crypto.randomUUID(),
        crawler_id: crawlerResponse.id,
        user_uuid: crawlerResponse.user_uuid,
        level: 'owner',
        created_at: new Date().toISOString(),
      }, { status: 201 }),
      { once: true },
    ),
  );
}

function mockSupabaseCrawlerList(data: unknown[] = [mockCrawlerResponse()], total: number = 1) {
  appendHandlers(
    network,
    http.all(
      requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'GET' }),
      () => HttpResponse.json(data, { headers: { 'content-range': data.length > 0 ? `0-${data.length - 1}/${total}` : `*/${total}` } }),
      { once: true },
    ),
  );
}

function mockSupabaseCrawlerGet(data: JsonBodyType = mockCrawlerResponse()) {
  appendHandlers(
    network,
    http.all(
      requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'GET' }),
      () => HttpResponse.json(data),
      { once: true },
    ),
  );
}

function mockSupabaseCrawlerNotFound() {
  appendHandlers(
    network,
    http.all(
      requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'GET' }),
      () => HttpResponse.json({
        code: 'PGRST116',
        details: 'The result contains 0 rows',
        hint: null,
        message: 'JSON object requested, multiple (or no) rows returned',
      }, { status: 406 }),
      { once: true },
    ),
  );
}

describe('crawler-manager-worker', () => {
  describe('OPTIONS preflight', () => {
    it('returns 204 with CORS headers for allowed origin', async () => {
      const request = new Request(WORKER_URL, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    });

    it('returns 204 without CORS origin header for unknown origin', async () => {
      const request = new Request(WORKER_URL, {
        method: 'OPTIONS',
        headers: { Origin: 'https://unknown.example.com' },
      });
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('crawler-manager-worker');
    });

    it('includes /authentication/token in help endpoints', async () => {
      const request = new Request(WORKER_URL, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await SELF.fetch(request);

      const body = await response.json();
      const tokenEndpoint = body.endpoints.find((endpoint: { path: string }) => endpoint.path === '/authentication/token');
      expect(tokenEndpoint).toBeDefined();
      expect(tokenEndpoint.method).toBe('POST');
    });
  });

  describe('authentication', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const request = new Request(`${WORKER_URL}/crawlers`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /authentication/token', () => {
    it('returns a JWT for valid Google token', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://www.googleapis.com', { path: '/oauth2/v3/userinfo', method: 'GET' }),
          () => HttpResponse.json({ sub: 'google-sub-123', email: 'test@example.com' }),
          { once: true },
        ),
      );

      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/accounts/, method: 'GET' }),
          () => HttpResponse.json({ provider: 'google', identifier: 'google-sub-123', uuid: MOCK_USER_UUID }),
          { once: true },
        ),
      );

      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google', access_token: 'valid-google-token' }),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
      expect(body.expires_in).toBe(86400);
    });

    it('returns a JWT for valid GitHub token', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://api.github.com', { path: '/user', method: 'GET' }),
          () => HttpResponse.json({ id: 12345, login: 'testuser' }),
          { once: true },
        ),
      );

      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/accounts/, method: 'GET' }),
          () => HttpResponse.json({ provider: 'github', identifier: '12345', uuid: MOCK_USER_UUID }),
          { once: true },
        ),
      );

      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'github', access_token: 'valid-github-token' }),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.token).toBeDefined();
      expect(body.token_type).toBe('Bearer');
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
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 for invalid provider', async () => {
      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'twitter', access_token: 'some-token' }),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing access_token', async () => {
      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google' }),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
    });

    it('returns 400 for non-JSON body', async () => {
      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
        },
        body: 'not json',
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
    });

    it('returns 401 when provider rejects the token', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://www.googleapis.com', { path: '/oauth2/v3/userinfo', method: 'GET' }),
          () => HttpResponse.json({ error: 'invalid_token' }, { status: 401 }),
          { once: true },
        ),
      );

      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google', access_token: 'bad-token' }),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(401);
    });

    it('returns 401 when no account exists for the provider user', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://www.googleapis.com', { path: '/oauth2/v3/userinfo', method: 'GET' }),
          () => HttpResponse.json({ sub: 'unknown-sub' }),
          { once: true },
        ),
      );

      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/accounts/, method: 'GET' }),
          () => HttpResponse.json({
            code: 'PGRST116',
            details: 'The result contains 0 rows',
            hint: null,
            message: 'JSON object requested, multiple (or no) rows returned',
          }, { status: 406 }),
          { once: true },
        ),
      );

      const request = new Request(`${WORKER_URL}/authentication/token`, {
        method: 'POST',
        headers: {
          Origin: 'https://example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider: 'google', access_token: 'valid-but-unregistered' }),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /crawlers validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        body: 'not json',
      });
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error_description).toContain('unsafe regex pattern');
    });

    it('returns 400 for invalid type', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', type: 'invalid', code: '(x) => x', url_pattern: '.*' }),
      });
      const response = await SELF.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error_description).toContain('type');
    });

    it('returns 400 for web crawler without url_pattern', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', type: 'web', code: '(x) => x' }),
      });
      const response = await SELF.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error_description).toContain('url_pattern');
    });

    it('returns 400 for data crawler without input_schema', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', type: 'data', code: '(x) => x' }),
      });
      const response = await SELF.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error_description).toContain('input_schema');
    });

    it('returns 400 for non-object output_schema', async () => {
      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', url_pattern: '.*', code: '(x) => x', output_schema: 'invalid' }),
      });
      const response = await SELF.fetch(request);
      expect(response.status).toBe(400);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error_description).toContain('output_schema');
    });
  });

  describe('POST /crawlers success', () => {
    it('creates a web crawler and returns 201', async () => {
      const crawlerData = validCrawlerBody();
      mockSupabaseCrawlerCreate(crawlerData);

      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(crawlerData),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Test Crawler');
      expect(body.id).toBe(MOCK_CRAWLER_ID);
      expect(body.type).toBe('web');
    });

    it('creates a data crawler and returns 201', async () => {
      const crawlerData = validDataCrawlerBody();
      mockSupabaseCrawlerCreate({
        ...crawlerData,
        url_pattern: null,
      });

      const request = await authenticatedRequest('/crawlers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(crawlerData),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Data Crawler');
      expect(body.type).toBe('data');
    });
  });

  describe('GET /crawlers', () => {
    it('lists crawlers for the authenticated user', async () => {
      mockSupabaseCrawlerList();

      const request = await authenticatedRequest('/crawlers');
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toBeDefined();
      expect(body.offset).toBe(0);
      expect(body.limit).toBe(10);
    });

    it('returns 400 for negative offset', async () => {
      const request = await authenticatedRequest('/crawlers?offset=-1');
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('offset');
    });

    it('returns 400 for zero limit', async () => {
      const request = await authenticatedRequest('/crawlers?limit=0');
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('limit');
    });

    it('returns 400 for limit exceeding maximum', async () => {
      const request = await authenticatedRequest('/crawlers?limit=101');
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('limit');
    });

    it('returns 400 for non-numeric offset', async () => {
      const request = await authenticatedRequest('/crawlers?offset=abc');
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('offset');
    });

    it('returns 400 for non-integer limit', async () => {
      const request = await authenticatedRequest('/crawlers?limit=1.5');
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.id).toBe(MOCK_CRAWLER_ID);
    });

    it('returns 404 when crawler belongs to another user', async () => {
      mockSupabaseCrawlerNotFound();

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`);
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /crawlers/:id validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        body: 'not json',
      });
      const response = await SELF.fetch(request);

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
      const response = await SELF.fetch(request);

      expect(response.status).toBe(400);
    });
  });

  describe('PUT /crawlers/:id success', () => {
    it('updates a crawler and returns 200', async () => {
      const updatedData = { name: 'Updated Crawler', url_pattern: '.*', code: '(x) => x.toUpperCase()' };
      const mockResponse = mockCrawlerResponse(updatedData);

      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'PATCH' }),
          () => HttpResponse.json(mockResponse),
          { once: true },
        ),
      );

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedData),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('Updated Crawler');
    });

    it('returns 404 when crawler does not exist or belongs to another user', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'PATCH' }),
          () => HttpResponse.json({
            code: 'PGRST116',
            details: 'The result contains 0 rows',
            hint: null,
            message: 'JSON object requested, multiple (or no) rows returned',
          }, { status: 406 }),
          { once: true },
        ),
      );

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCrawlerBody()),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /crawlers/:id', () => {
    it('deletes a crawler and returns 200', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'DELETE' }),
          () => HttpResponse.json([mockCrawlerResponse()]),
          { once: true },
        ),
      );

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'DELETE',
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(true);
    });

    it('returns 404 when crawler belongs to another user', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'DELETE' }),
          () => HttpResponse.json([]),
          { once: true },
        ),
      );

      const request = await authenticatedRequest(`/crawlers/${MOCK_CRAWLER_ID}`, {
        method: 'DELETE',
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
    });
  });

  describe('invalid UUID format', () => {
    it('returns 404 for invalid crawler ID in GET', async () => {
      const request = await authenticatedRequest('/crawlers/abc');
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
    });

    it('returns 404 for invalid crawler ID in PUT', async () => {
      const request = await authenticatedRequest('/crawlers/abc', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validCrawlerBody()),
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
    });

    it('returns 404 for invalid crawler ID in DELETE', async () => {
      const request = await authenticatedRequest('/crawlers/abc', {
        method: 'DELETE',
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const request = new Request(`${WORKER_URL}/unknown`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await SELF.fetch(request);

      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toBe('not_found');
    });
  });

  describe('executeCrawlerByName RPC', () => {
    // An RPC promise is callable and expect().rejects calls what it is given, so rejecting calls are wrapped in a function
    const crawlerManager = exports.default as unknown as Service<typeof CrawlerManagerWorker>;
    const INVALID_NAME_MESSAGE = 'Crawler name must be a non-empty string of at most 255 characters';
    let fetchSpy: MockInstance<typeof fetch>;

    function requestedOrigins(): string[] {
      return fetchSpy.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).origin);
    }

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('runs the system crawler code on the input URL and returns the result', async () => {
      const crawler = mockCrawlerResponse({
        user_uuid: SYSTEM_USER_UUID,
        name: 'geeknews-list',
        url_pattern: '^https://news\\.hada\\.io.*$',
        code: '(body) => [{ title: body }]',
      });

      let supabasePath: string | undefined;
      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'GET' }),
          ({ request }) => {
            const url = new URL(request.url);
            supabasePath = `${url.pathname}${url.search}`;
            return HttpResponse.json([crawler]);
          },
          { once: true },
        ),
      );

      // The Lambda only fetches the page and returns its body; the code runs in a Dynamic Worker (LOADER)
      let codeRunnerBody: unknown;
      appendHandlers(
        network,
        http.all(requestMatching('https://code-runner.example.com', { path: '/run', method: 'POST' }), async ({ request }) => {
          codeRunnerBody = JSON.parse(await request.text());
          return HttpResponse.json({ type: 'web', mode: 'run', result: 'First' });
        }, { once: true }),
      );

      const result = await crawlerManager.executeCrawlerByName('geeknews-list', { url: 'https://news.hada.io/' });

      expect(result).toEqual({ type: 'web', result: [{ title: 'First' }] });
      expect(codeRunnerBody).toEqual({ type: 'web', mode: 'run', url: 'https://news.hada.io/', code: '(body) => body' });
      expect(supabasePath).toContain(`user_uuid=eq.${SYSTEM_USER_UUID}`);
      expect(supabasePath).toContain('name=eq.geeknews-list');
      expect(requestedOrigins()).toEqual(['https://supabase.example.com', 'https://code-runner.example.com']);
    });

    it('throws without calling the code runner when the system crawler does not exist', async () => {
      appendHandlers(
        network,
        http.all(
          requestMatching('https://supabase.example.com', { path: /^\/rest\/v1\/crawlers/, method: 'GET' }),
          () => HttpResponse.json([]),
          { once: true },
        ),
      );

      await expect(() =>
        crawlerManager.executeCrawlerByName('missing-crawler', { url: 'https://news.hada.io/' }),
      ).rejects.toThrow("System crawler 'missing-crawler' not found");
      expect(requestedOrigins()).toEqual(['https://supabase.example.com']);
    });

    it('throws without querying the database for an empty name', async () => {
      await expect(() =>
        crawlerManager.executeCrawlerByName('', { url: 'https://news.hada.io/' }),
      ).rejects.toThrow(INVALID_NAME_MESSAGE);
      expect(requestedOrigins()).toEqual([]);
    });

    it('throws without querying the database for a 256-character name', async () => {
      await expect(() =>
        crawlerManager.executeCrawlerByName('x'.repeat(256), { url: 'https://news.hada.io/' }),
      ).rejects.toThrow(INVALID_NAME_MESSAGE);
      expect(requestedOrigins()).toEqual([]);
    });

    it('throws without querying the database for a non-string name', async () => {
      await expect(() =>
        crawlerManager.executeCrawlerByName(42 as unknown as string, { url: 'https://news.hada.io/' }),
      ).rejects.toThrow(INVALID_NAME_MESSAGE);
      expect(requestedOrigins()).toEqual([]);
    });
  });
});
