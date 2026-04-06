import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

// Must import handler after vi.mock so the mock is applied
const { handler } = await import('../sources/index.ts');

process.env.ALLOWED_ORIGINS = 'https://example.com';

function createEvent(overrides: {
  method?: string;
  path?: string;
  origin?: string;
  body?: string;
  contentType?: string;
  isBase64Encoded?: boolean;
} = {}) {
  return {
    version: '2.0',
    requestContext: {
      http: {
        method: overrides.method ?? 'GET',
        path: overrides.path ?? '/',
      },
    },
    headers: {
      origin: overrides.origin ?? 'https://example.com',
      ...(overrides.contentType ? { 'content-type': overrides.contentType } : {}),
    },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
  };
}

describe('crawler-code-runner-function', () => {
  describe('OPTIONS preflight', () => {
    it('returns 204 with CORS headers for allowed origin', async () => {
      const event = createEvent({ method: 'OPTIONS', origin: 'https://example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(204);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(response.headers['Access-Control-Allow-Methods']).toContain('POST');
    });

    it('returns 204 without CORS origin header for unknown origin', async () => {
      const event = createEvent({ method: 'OPTIONS', origin: 'https://unknown.example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(204);
      expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  describe('HEAD request', () => {
    it('returns 200 with Content-Type header and empty body', async () => {
      const event = createEvent({ method: 'HEAD', origin: 'https://example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(response.headers['Content-Type']).toBe('application/json');
      expect(response.body).toBe('');
    });
  });

  describe('GET / and GET /help', () => {
    it('returns help JSON on GET /', async () => {
      const event = createEvent({ origin: 'https://example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('crawler-code-runner-function');
      expect(body.endpoints).toBeDefined();
      expect(body.endpoints.length).toBeGreaterThan(0);
    });

    it('returns help JSON on GET /help', async () => {
      const event = createEvent({ path: '/help', origin: 'https://example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.name).toBe('crawler-code-runner-function');
    });
  });

  describe('POST /run validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'text/plain',
        body: 'not json',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 for missing type field', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'test', url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('type');
    });

    it('returns 400 for invalid type value', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'invalid', mode: 'test', url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('type');
    });

    it('returns 400 for missing mode field', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'web', url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('mode');
    });

    it('returns 400 for invalid mode value', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'web', mode: 'invalid', url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('mode');
    });

    it('returns 400 for missing url field when type is web', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'web', mode: 'run', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('url');
    });

    it('returns 400 for missing data field when type is data', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'data', mode: 'run', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('data');
    });

    it('returns 400 for missing code field', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'web', mode: 'run', url: 'https://example.com' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('code');
    });

    it('returns 400 for invalid URL format', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'web', mode: 'run', url: 'not-a-url', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('valid URL');
    });
  });

  describe('POST /run web type - fetch failures', () => {
    it('returns 502 when target URL fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => text',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(502);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('fetch_failed');

      vi.unstubAllGlobals();
    });
  });

  describe('POST /run web type - execution failures', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('hello world'),
      }));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns 422 when code execution throws an error', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => { throw new Error("intentional error"); }',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('execution_failed');
      expect(body.error_description).toContain('intentional error');
    });

    it('returns 422 when code is syntactically invalid', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/data',
          code: '((( invalid syntax',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('execution_failed');
    });
  });

  describe('POST /run web type - successful execution', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('executes code and returns result with mode test', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('hello world'),
      }));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'test',
          url: 'https://target.example.com/data',
          code: '(text) => text.toUpperCase()',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('web');
      expect(body.mode).toBe('test');
      expect(body.result).toBe('HELLO WORLD');
    });

    it('executes code and returns result with mode run', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('hello world'),
      }));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => text.length',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('web');
      expect(body.mode).toBe('run');
      expect(body.result).toBe(11);
    });

    it('handles code that returns an object', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('<title>Test Page</title><p>Content here</p>'),
      }));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/page',
          code: '(text) => ({ length: text.length, hasTitle: text.includes("<title>") })',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('web');
      expect(body.mode).toBe('run');
      expect(body.result.length).toBe(43);
      expect(body.result.hasTitle).toBe(true);
    });

    it('handles async code', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('async test'),
      }));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/data',
          code: 'async (text) => text.split(" ")',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('web');
      expect(body.mode).toBe('run');
      expect(body.result).toEqual(['async', 'test']);
    });

    it('handles base64 encoded body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('hello'),
      }));

      const rawBody = JSON.stringify({
        type: 'web',
        mode: 'test',
        url: 'https://target.example.com/data',
        code: '(text) => text.toUpperCase()',
      });

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        body: Buffer.from(rawBody).toString('base64'),
        isBase64Encoded: true,
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('web');
      expect(body.mode).toBe('test');
      expect(body.result).toBe('HELLO');
    });

    it('normalizes undefined result to null', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('hello'),
      }));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'web',
          mode: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => undefined',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.result).toBeNull();
    });
  });

  describe('POST /run data type - successful execution', () => {
    it('executes code against provided data object', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: { items: [1, 2, 3] },
          code: '(data) => data.items.length',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('data');
      expect(body.mode).toBe('run');
      expect(body.result).toBe(3);
    });

    it('executes code against provided data array', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'test',
          data: [10, 20, 30],
          code: '(data) => data.map((x) => x * 2)',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('data');
      expect(body.mode).toBe('test');
      expect(body.result).toEqual([20, 40, 60]);
    });

    it('executes code against provided string data', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: 'hello world',
          code: '(data) => data.toUpperCase()',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('data');
      expect(body.mode).toBe('run');
      expect(body.result).toBe('HELLO WORLD');
    });

    it('executes code against null data', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: null,
          code: '(data) => data === null ? "was null" : "not null"',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('data');
      expect(body.mode).toBe('run');
      expect(body.result).toBe('was null');
    });

    it('ensures Array.isArray works for array data in sandbox', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'test',
          data: [1, 2, 3],
          code: '(data) => Array.isArray(data)',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.result).toBe(true);
    });

    it('normalizes undefined result to null for data type', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: 'anything',
          code: '(data) => undefined',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.result).toBeNull();
    });

    it('does not perform SSRF check for data type', async () => {
      // data type should not trigger any fetch or DNS lookup
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: { value: 42 },
          code: '(data) => data.value + 1',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.result).toBe(43);
    });
  });

  describe('POST /run data type - execution failures', () => {
    it('returns 422 when code execution throws an error', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: { value: 1 },
          code: '(data) => { throw new Error("data processing error"); }',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('execution_failed');
      expect(body.error_description).toContain('data processing error');
    });

    it('returns 422 when code is syntactically invalid', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'data',
          mode: 'run',
          data: 'test',
          code: '((( invalid syntax',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(422);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('execution_failed');
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const event = createEvent({ path: '/unknown', origin: 'https://example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('not_found');
    });

    it('returns 404 for unsupported method on known path', async () => {
      const event = createEvent({ method: 'PUT', path: '/run', origin: 'https://example.com' });
      const response = await handler(event);

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('not_found');
    });
  });
});
