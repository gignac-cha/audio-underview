import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('crawler-code-runner-worker', () => {
  describe('OPTIONS preflight', () => {
    it('returns 204 with CORS headers for allowed origin', async () => {
      const request = new Request(WORKER_URL, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
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
      expect(body.name).toBe('crawler-code-runner-worker');
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
      expect(body.name).toBe('crawler-code-runner-worker');
    });
  });

  describe('POST /run validation', () => {
    it('returns 400 for non-JSON body', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'text/plain' },
        body: 'not json',
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 for missing type field', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('type');
    });

    it('returns 400 for invalid type value', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'invalid', url: 'https://example.com', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
    });

    it('returns 400 for missing url field', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'run', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('url');
    });

    it('returns 400 for missing code field', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'run', url: 'https://example.com' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('code');
    });

    it('returns 400 for invalid URL format', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'run', url: 'not-a-url', code: '(x) => x' }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('invalid_request');
      expect(body.error_description).toContain('valid URL');
    });
  });

  describe('POST /run fetch failures', () => {
    it('returns 502 when target URL fetch fails', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/data', method: 'GET' })
        .replyWithError(new Error('Network error'));

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => text',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toBe('fetch_failed');
    });
  });

  describe('POST /run execution failures', () => {
    it('returns 422 when code execution throws an error', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/data', method: 'GET' })
        .reply(200, 'hello world');

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => { throw new Error("intentional error"); }',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toBe('execution_failed');
      expect(body.error_description).toContain('intentional error');
    });

    it('returns 422 when code is syntactically invalid', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/data', method: 'GET' })
        .reply(200, 'hello world');

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'run',
          url: 'https://target.example.com/data',
          code: '((( invalid syntax',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error).toBe('execution_failed');
    });
  });

  describe('POST /run successful execution', () => {
    it('executes code and returns result with type test', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/data', method: 'GET' })
        .reply(200, 'hello world');

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'test',
          url: 'https://target.example.com/data',
          code: '(text) => text.toUpperCase()',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.type).toBe('test');
      expect(body.result).toBe('HELLO WORLD');
    });

    it('executes code and returns result with type run', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/data', method: 'GET' })
        .reply(200, 'hello world');

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'run',
          url: 'https://target.example.com/data',
          code: '(text) => text.length',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.type).toBe('run');
      expect(body.result).toBe(11);
    });

    it('handles code that returns an object', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/page', method: 'GET' })
        .reply(200, '<title>Test Page</title><p>Content here</p>');

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'run',
          url: 'https://target.example.com/page',
          code: '(text) => ({ length: text.length, hasTitle: text.includes("<title>") })',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.type).toBe('run');
      expect(body.result.length).toBe(43);
      expect(body.result.hasTitle).toBe(true);
    });

    it('handles async code', async () => {
      fetchMock
        .get('https://target.example.com')
        .intercept({ path: '/data', method: 'GET' })
        .reply(200, 'async test');

      const request = new Request(`${WORKER_URL}/run`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'run',
          url: 'https://target.example.com/data',
          code: 'async (text) => text.split(" ")',
        }),
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.type).toBe('run');
      expect(body.result).toEqual(['async', 'test']);
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

    it('returns 405 for unsupported method on known path', async () => {
      const request = new Request(`${WORKER_URL}/run`, {
        method: 'PUT',
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
      const body = await response.json();
      expect(body.error).toBe('method_not_allowed');
    });
  });
});
