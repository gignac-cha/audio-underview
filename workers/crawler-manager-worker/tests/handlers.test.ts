import { describe, expect, it } from 'vitest';
import { createCrawlerManagerRouter } from '../sources/application.ts';
import type { CrawlerManagerServices } from '../sources/services.ts';
import {
  CRAWLER_ID,
  createBearerToken,
  createFakeServices,
  environment,
  executionContext,
  mockCrawler,
  USER_UUID,
} from './test-helpers.ts';

const createApplication = (services: CrawlerManagerServices) =>
  createCrawlerManagerRouter(() => services);

const request = async (
  services: CrawlerManagerServices,
  method: string,
  path: string,
  options: { body?: unknown; token?: string | null } = {},
): Promise<Response> => {
  const token = options.token === undefined ? await createBearerToken() : options.token;
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return createApplication(services).fetch(
    new Request(`https://worker.example.com${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    environment,
    executionContext,
  );
};

const validWebBody = {
  name: 'My Crawler',
  type: 'web',
  url_pattern: '^https://example\\.com/',
  code: '(body) => body.length',
};

describe('authentication', () => {
  it.each(['POST', 'GET'] as const)('rejects %s /crawlers without a token', async (method) => {
    const response = await request(createFakeServices(), method, '/crawlers', { token: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'unauthorized',
      error_description: 'Valid authentication is required',
    });
  });

  it('returns 500 server configuration error when JWT_SECRET is missing', async () => {
    const response = await createApplication(createFakeServices()).fetch(
      new Request('https://worker.example.com/crawlers'),
      { ALLOWED_ORIGINS: '' },
      executionContext,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error_description: 'Server configuration error' });
  });
});

describe('POST /crawlers', () => {
  it('creates a web crawler with forced input_schema (201)', async () => {
    let received: unknown;
    const services = createFakeServices({
      crawlers: {
        createWithOwnerPermission: (input) => {
          received = input;
          return Promise.resolve(mockCrawler);
        },
      },
    });

    const response = await request(services, 'POST', '/crawlers', { body: validWebBody });
    expect(response.status).toBe(201);
    expect(received).toMatchObject({
      userUUID: USER_UUID,
      inputSchema: { body: 'string' },
      urlPattern: validWebBody.url_pattern,
    });
  });

  it('stores url_pattern as null for data crawlers', async () => {
    let received: { urlPattern: string | null } | undefined;
    const services = createFakeServices({
      crawlers: {
        createWithOwnerPermission: (input) => {
          received = input;
          return Promise.resolve({ ...mockCrawler, type: 'data', url_pattern: null });
        },
      },
    });

    const response = await request(services, 'POST', '/crawlers', {
      body: { name: 'D', type: 'data', input_schema: { items: {} }, code: '(input) => input' },
    });
    expect(response.status).toBe(201);
    expect(received?.urlPattern).toBeNull();
  });

  it.each([
    [{ ...validWebBody, name: '   ' }, '공백 이름'],
    [{ ...validWebBody, url_pattern: undefined }, 'web인데 url_pattern 없음'],
    [{ ...validWebBody, url_pattern: '([' }, '컴파일 불가 regex'],
    [{ ...validWebBody, type: 'file' }, '무효 type'],
    [{ name: 'X', type: 'data', code: '() => 1' }, 'data인데 input_schema 없음'],
  ])('rejects invalid bodies with 400 (%#: %s)', async (body, _label) => {
    const response = await request(createFakeServices(), 'POST', '/crawlers', { body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('rejects ReDoS-prone url_pattern with 400', async () => {
    const response = await request(createFakeServices(), 'POST', '/crawlers', {
      body: { ...validWebBody, url_pattern: '(a+)+$' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_description: "Field 'url_pattern' contains potentially unsafe regex pattern",
    });
  });

  it('rejects a non-JSON body with 400', async () => {
    const token = await createBearerToken();
    const response = await createApplication(createFakeServices()).fetch(
      new Request('https://worker.example.com/crawlers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: 'not json',
      }),
      environment,
      executionContext,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_description: 'Request body must be valid JSON',
    });
  });
});

describe('GET /crawlers', () => {
  it('returns the list envelope with defaults', async () => {
    const services = createFakeServices({
      crawlers: { list: () => Promise.resolve({ data: [mockCrawler], total: 1 }) },
    });
    const response = await request(services, 'GET', '/crawlers');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, offset: 0, limit: 20 });
  });

  it('treats empty offset as unspecified (통일된 동작)', async () => {
    const services = createFakeServices({
      crawlers: { list: () => Promise.resolve({ data: [], total: 0 }) },
    });
    const response = await request(services, 'GET', '/crawlers?offset=&limit=5');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ offset: 0, limit: 5 });
  });

  it.each(['offset=-1', 'limit=0', 'limit=101', 'offset=abc', 'limit=1.5'])(
    'rejects invalid pagination (%s)',
    async (query) => {
      const response = await request(createFakeServices(), 'GET', `/crawlers?${query}`);
      expect(response.status).toBe(400);
    },
  );
});

describe('GET/PUT/DELETE /crawlers/:crawlerID', () => {
  it('returns 404 for another user (정보 은닉)', async () => {
    const services = createFakeServices({
      crawlers: { get: () => Promise.resolve(undefined) },
    });
    const response = await request(services, 'GET', `/crawlers/${CRAWLER_ID}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error_description: 'Crawler not found' });
  });

  it('returns 404 for an invalid UUID path', async () => {
    const response = await request(createFakeServices(), 'GET', '/crawlers/not-a-uuid');
    expect(response.status).toBe(404);
  });

  it('replaces a crawler with PUT (전체 교체)', async () => {
    let received: unknown;
    const services = createFakeServices({
      crawlers: {
        update: (_id, _user, input) => {
          received = input;
          return Promise.resolve(mockCrawler);
        },
      },
    });
    const response = await request(services, 'PUT', `/crawlers/${CRAWLER_ID}`, {
      body: validWebBody,
    });
    expect(response.status).toBe(200);
    expect(received).toMatchObject({ input_schema: { body: 'string' } });
  });

  it('returns 404 when updating a crawler that is not owned', async () => {
    const services = createFakeServices({
      crawlers: { update: () => Promise.resolve(undefined) },
    });
    const response = await request(services, 'PUT', `/crawlers/${CRAWLER_ID}`, {
      body: validWebBody,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_description: 'Crawler not found or not owned by you',
    });
  });

  it('deletes a crawler ({ deleted: true })', async () => {
    const services = createFakeServices({ crawlers: { delete: () => Promise.resolve(true) } });
    const response = await request(services, 'DELETE', `/crawlers/${CRAWLER_ID}`);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it('maps FK RESTRICT deletion failures to 409 (레거시 500 개선)', async () => {
    const services = createFakeServices({
      crawlers: {
        delete: () =>
          Promise.reject(
            Object.assign(new Error('violates foreign key constraint'), { code: '23503' }),
          ),
      },
    });
    const response = await request(services, 'DELETE', `/crawlers/${CRAWLER_ID}`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict' });
  });

  it('returns 405 with Allow for unsupported methods', async () => {
    const response = await request(createFakeServices(), 'PATCH', `/crawlers/${CRAWLER_ID}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, PUT, DELETE, OPTIONS');
  });
});
