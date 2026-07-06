import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';
import { createHandler, type HandlerDependencies } from '../sources/index.ts';
import type { LambdaEvent } from '../sources/lambda.ts';

const JWT_SECRET = 'function-test-secret';
const USER_UUID = '00000000-0000-4000-8000-000000000009';

const base64URL = (value: string | Buffer): string =>
  Buffer.from(value).toString('base64url');

const createToken = (claims: Record<string, unknown> = {}): string => {
  const headerPart = base64URL(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadPart = base64URL(
    JSON.stringify({
      sub: USER_UUID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      ...claims,
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${headerPart}.${payloadPart}`)
    .digest('base64url');
  return `${headerPart}.${payloadPart}.${signature}`;
};

/** 공인 IP로 resolve되는 lookup fake — 네트워크 없는 테스트용 */
const publicLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

const createEvent = (
  body: unknown,
  overrides: Partial<{ method: string; path: string; token: string | null; base64: boolean }> = {},
): LambdaEvent => {
  const token = overrides.token === undefined ? createToken() : overrides.token;
  const rawBody = JSON.stringify(body);
  return {
    requestContext: {
      http: { method: overrides.method ?? 'POST', path: overrides.path ?? '/run' },
    },
    headers: {
      'content-type': 'application/json',
      ...(token !== null && { authorization: `Bearer ${token}` }),
    },
    body: overrides.base64 === true ? Buffer.from(rawBody).toString('base64') : rawBody,
    isBase64Encoded: overrides.base64 === true,
  };
};

const invoke = (event: LambdaEvent, dependencies: HandlerDependencies = {}) =>
  createHandler({
    environment: { JWT_SECRET, ALLOWED_ORIGINS: 'https://app.example.com' },
    lookupImplementation: publicLookup,
    ...dependencies,
  })(event);

const parseBody = (body: string | undefined): Record<string, unknown> =>
  JSON.parse(body ?? '{}') as Record<string, unknown>;

describe('routing', () => {
  it('returns 404 for unknown paths', async () => {
    const response = await invoke(createEvent({}, { path: '/other' }));
    expect(response.statusCode).toBe(404);
  });

  it('returns 405 with Allow for non-POST', async () => {
    const response = await invoke(createEvent({}, { method: 'GET' }));
    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe('POST');
  });

  it('handles OPTIONS with 204', async () => {
    const response = await invoke(createEvent({}, { method: 'OPTIONS' }));
    expect(response.statusCode).toBe(204);
  });
});

describe('authentication (신규 — 레거시는 무인증)', () => {
  it('rejects requests without a token', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 1, code: '(x) => x' }, { token: null }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('rejects tokens signed with a different secret', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 1, code: '(x) => x' }),
      { environment: { JWT_SECRET: 'different-secret', ALLOWED_ORIGINS: '' } },
    );
    expect(response.statusCode).toBe(401);
  });

  it('returns 500 when JWT_SECRET is not configured', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 1, code: '(x) => x' }),
      { environment: { ALLOWED_ORIGINS: '' } },
    );
    expect(response.statusCode).toBe(500);
  });
});

describe('validation', () => {
  it.each([
    [{ mode: 'test', code: '() => 1' }, 'type 누락'],
    [{ type: 'web', mode: 'later', url: 'https://a.com', code: '() => 1' }, '무효 mode'],
    [{ type: 'web', mode: 'test', code: '() => 1' }, 'web인데 url 없음'],
    [{ type: 'web', mode: 'test', url: 'not a url', code: '() => 1' }, '무효 URL'],
    [{ type: 'data', mode: 'test', code: '() => 1' }, 'data인데 data 키 없음'],
    [{ type: 'data', mode: 'test', data: 1, code: `(x) => ${'y'.repeat(10_001)}` }, 'code 초과'],
  ])('rejects invalid bodies with 400 (%#: %s)', async (body, _label) => {
    const response = await invoke(createEvent(body));
    expect(response.statusCode).toBe(400);
    expect(parseBody(response.body).error).toBe('invalid_request');
  });

  it('accepts data: null (키만 있으면 통과)', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: null, code: '(x) => x === null' }),
    );
    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body).result).toBe(true);
  });
});

describe('data execution', () => {
  it.each([
    [{ list: [1, 2] }, '(x) => x.list.length', 2],
    [[1, 2, 3], '(x) => Array.isArray(x)', true], // sandbox 내 Array.isArray 정합성
    ['text', '(x) => x.toUpperCase()', 'TEXT'],
    [7, '(x) => x * 6', 42],
  ])('runs user code against %j', async (data, code, expected) => {
    const response = await invoke(createEvent({ type: 'data', mode: 'run', data, code }));
    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body)).toMatchObject({ type: 'data', mode: 'run', result: expected });
  });

  it('supports async user code', async () => {
    const response = await invoke(
      createEvent({
        type: 'data',
        mode: 'test',
        data: 5,
        code: 'async (x) => { const doubled = await Promise.resolve(x * 2); return doubled; }',
      }),
    );
    expect(parseBody(response.body).result).toBe(10);
  });

  it('omits the result key when user code returns undefined (계약)', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 1, code: '() => undefined' }),
    );
    expect(response.statusCode).toBe(200);
    expect('result' in parseBody(response.body)).toBe(false);
  });

  it('blocks sandbox access to fetch/process/require', async () => {
    const response = await invoke(
      createEvent({
        type: 'data',
        mode: 'test',
        data: null,
        code: '() => [typeof fetch, typeof process, typeof require]',
      }),
    );
    expect(parseBody(response.body).result).toEqual(['undefined', 'undefined', 'undefined']);
  });

  it('returns 422 execution_failed with the original message for user errors', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 1, code: '() => { throw new Error("custom boom"); }' }),
    );
    expect(response.statusCode).toBe(422);
    expect(parseBody(response.body)).toMatchObject({
      error: 'execution_failed',
      error_description: 'custom boom',
    });
  });

  it('returns 422 execution_failed for syntax errors', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 1, code: 'not a function ===' }),
    );
    expect(response.statusCode).toBe(422);
  });

  it('returns 422 execution_timeout for runaway async code', async () => {
    const response = await invoke(
      createEvent({
        type: 'data',
        mode: 'test',
        data: 1,
        code: 'async (x) => new Promise(() => {})',
      }),
    );
    expect(response.statusCode).toBe(422);
    expect(parseBody(response.body).error).toBe('execution_timeout');
  }, 10_000);
});

describe('web execution', () => {
  const fetchReturning = (text: string, headers: Record<string, string> = {}) =>
    (() => Promise.resolve(new Response(text, { status: 200, headers }))) as typeof fetch;

  it('fetches the URL and passes the body text to user code', async () => {
    const response = await invoke(
      createEvent({
        type: 'web',
        mode: 'run',
        url: 'https://public.example.com/page',
        code: '(body) => body.length',
      }),
      { fetchImplementation: fetchReturning('<html>hello</html>') },
    );
    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body).result).toBe(18);
  });

  it('blocks private-range targets with 400 (SSRF)', async () => {
    const response = await invoke(
      createEvent({
        type: 'web',
        mode: 'test',
        url: 'http://127.0.0.1:8080/internal',
        code: '(body) => body',
      }),
      { lookupImplementation: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) },
    );
    expect(response.statusCode).toBe(400);
    expect(parseBody(response.body).error_description).toContain('not allowed');
  });

  it('blocks targets when ANY resolved address is private', async () => {
    const response = await invoke(
      createEvent({
        type: 'web',
        mode: 'test',
        url: 'https://rebinding.example.com',
        code: '(body) => body',
      }),
      {
        lookupImplementation: () =>
          Promise.resolve([
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.5', family: 4 },
          ]),
      },
    );
    expect(response.statusCode).toBe(400);
  });

  it('returns 502 when DNS resolution fails', async () => {
    const response = await invoke(
      createEvent({ type: 'web', mode: 'test', url: 'https://nx.example.com', code: '(b) => b' }),
      { lookupImplementation: () => Promise.reject(new Error('ENOTFOUND')) },
    );
    expect(response.statusCode).toBe(502);
    expect(parseBody(response.body).error).toBe('fetch_failed');
  });

  it('returns 502 when the fetch fails', async () => {
    const response = await invoke(
      createEvent({ type: 'web', mode: 'test', url: 'https://down.example.com', code: '(b) => b' }),
      { fetchImplementation: (() => Promise.reject(new Error('connection refused'))) as typeof fetch },
    );
    expect(response.statusCode).toBe(502);
  });

  it('returns 413 when Content-Length exceeds the limit', async () => {
    const response = await invoke(
      createEvent({ type: 'web', mode: 'test', url: 'https://big.example.com', code: '(b) => b' }),
      {
        fetchImplementation: fetchReturning('small body', {
          'Content-Length': String(11 * 1024 * 1024),
        }),
      },
    );
    expect(response.statusCode).toBe(413);
    expect(parseBody(response.body).error).toBe('response_too_large');
  });

  it('data type does not run the SSRF check (레거시 계약)', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 'http://127.0.0.1', code: '(x) => x' }),
      { lookupImplementation: () => Promise.reject(new Error('should not be called')) },
    );
    expect(response.statusCode).toBe(200);
  });
});

describe('base64 body', () => {
  it('decodes base64-encoded bodies', async () => {
    const response = await invoke(
      createEvent({ type: 'data', mode: 'test', data: 3, code: '(x) => x + 1' }, { base64: true }),
    );
    expect(response.statusCode).toBe(200);
    expect(parseBody(response.body).result).toBe(4);
  });
});
