import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handler } from '../sources/index.ts';

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
        body: JSON.stringify({ url: 'https://example.com', code: '(x) => x' }),
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
        body: JSON.stringify({ type: 'invalid', url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 for missing url field', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'run', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('url');
    });

    it('returns 400 for missing code field', async () => {
      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({ type: 'run', url: 'https://example.com' }),
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
        body: JSON.stringify({ type: 'run', url: 'not-a-url', code: '(x) => x' }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('valid URL');
    });
  });

  describe('POST /run fetch failures', () => {
    it('returns 502 when target URL fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const event = createEvent({
        method: 'POST',
        path: '/run',
        origin: 'https://example.com',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'run',
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

  describe('POST /run execution failures', () => {
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
          type: 'run',
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
          type: 'run',
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

  describe('POST /run successful execution', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('executes code and returns result with type test', async () => {
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
          type: 'test',
          url: 'https://target.example.com/data',
          code: '(text) => text.toUpperCase()',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('test');
      expect(body.result).toBe('HELLO WORLD');
    });

    it('executes code and returns result with type run', async () => {
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
          type: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => text.length',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('run');
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
          type: 'run',
          url: 'https://target.example.com/page',
          code: '(text) => ({ length: text.length, hasTitle: text.includes("<title>") })',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('run');
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
          type: 'run',
          url: 'https://target.example.com/data',
          code: 'async (text) => text.split(" ")',
        }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.type).toBe('run');
      expect(body.result).toEqual(['async', 'test']);
    });

    it('handles base64 encoded body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('hello'),
      }));

      const rawBody = JSON.stringify({
        type: 'test',
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
      expect(body.type).toBe('test');
      expect(body.result).toBe('HELLO');
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
