import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_NAMES, type ProviderName } from './providers.ts';
import {
  VALIDATION_TIMEOUT_MILLISECONDS,
  classifyValidationStatus,
  isWellFormedProviderKey,
  validateProviderKey,
} from './validation.ts';

const KEY = 'sk-proj_underscores-and-dashes-1234';
const GATEWAY_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/vault-account/vault-gateway';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  hasSignal: boolean;
  redirect: string | undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

function stubFetch(respond: () => Response | Promise<Response>): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      captured.push({
        url: request.url,
        method: request.method,
        headers: headersToRecord(request.headers),
        body: request.body === null ? null : await request.text(),
        hasSignal: init?.signal instanceof AbortSignal,
        redirect: init?.redirect,
      });
      return respond();
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isWellFormedProviderKey', () => {
  it.each([
    'AIzaSyD-1234567890abcdefgHIJKLmnop',
    'AQ.Ab8RN6L1234567890abcdefg',
    'xai-abcdef1234567890ABCDEF',
    'sk-proj_underscores-and-dashes-1234',
    'x'.repeat(16),
    '~'.repeat(512),
  ])('accepts %j', (key) => {
    expect(isWellFormedProviderKey(key)).toBe(true);
  });

  it.each([
    ['an empty value', ''],
    ['a short value', 'short'],
    ['a leading space', ' AIzaSyD-1234567890abcdefgHIJKLmnop'],
    ['a trailing space', 'AIzaSyD-1234567890abcdefgHIJKLmnop '],
    ['a trailing newline', 'AIzaSyD-1234567890abcdefgHIJKLmnop\n'],
    [
      'a whole curl command',
      'curl https://api.openai.com/v1/models -H "Authorization: Bearer sk-proj-abcdefghijklmnop"',
    ],
    ['513 characters', 'a'.repeat(513)],
    ['a number', 12345678901234567890],
    ['a non-ASCII character', 'sk-proj-abcdefghijklmnopé'],
    ['undefined', undefined],
  ])('rejects %s', (_label, key) => {
    expect(isWellFormedProviderKey(key)).toBe(false);
  });
});

describe('validateProviderKey', () => {
  const expectedRequests: Record<
    ProviderName,
    { url: string; method: string; headers: Record<string, string>; body: string | null }
  > = {
    anthropic: {
      url: 'https://api.anthropic.com/v1/messages/count_tokens',
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}',
    },
    openai: {
      url: 'https://api.openai.com/v1/models',
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
      body: null,
    },
    google: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      method: 'GET',
      headers: { 'x-goog-api-key': KEY },
      body: null,
    },
    xai: {
      url: 'https://api.x.ai/v1/models',
      method: 'GET',
      headers: { authorization: `Bearer ${KEY}` },
      body: null,
    },
  };

  it.each(PROVIDER_NAMES)('calls %s with its own headers and keeps the key out of the URL', async (provider) => {
    const captured = stubFetch(() => new Response('{"data":[]}', { status: 200 }));
    const outcome = await validateProviderKey(provider, KEY, null);
    expect(outcome.result).toBe('valid');
    expect(captured).toHaveLength(1);
    const [request] = captured;
    const expected = expectedRequests[provider];
    expect(request?.url).toBe(expected.url);
    expect(request?.url).not.toContain(KEY);
    expect(request?.method).toBe(expected.method);
    expect(request?.body).toBe(expected.body);
    expect(request?.hasSignal).toBe(true);
    expect(request?.redirect).toBe('manual');
    for (const [name, value] of Object.entries(expected.headers)) {
      expect(request?.headers[name]).toBe(value);
    }
  });

  it.each([400, 401, 403])('reports %i as invalid', async (status) => {
    stubFetch(() => new Response('{"error":"bad key"}', { status }));
    await expect(validateProviderKey('openai', KEY, null)).resolves.toMatchObject({ result: 'invalid', status });
  });

  it.each([404, 429, 500, 502, 503])('reports %i as unavailable', async (status) => {
    stubFetch(() => new Response('upstream trouble', { status }));
    await expect(validateProviderKey('openai', KEY, null)).resolves.toMatchObject({ result: 'unavailable', status });
  });

  it('does not follow a redirect and reports it as unavailable', async () => {
    const captured = stubFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/collect' } }),
    );
    await expect(validateProviderKey('openai', KEY, null)).resolves.toMatchObject({
      result: 'unavailable',
      status: 302,
    });
    expect(captured.map((request) => request.url)).toEqual(['https://api.openai.com/v1/models']);
    expect(captured[0]?.redirect).toBe('manual');
  });

  it('reports 2xx as valid', () => {
    expect(classifyValidationStatus(200)).toBe('valid');
    expect(classifyValidationStatus(204)).toBe('valid');
    expect(classifyValidationStatus(299)).toBe('valid');
    expect(classifyValidationStatus(301)).toBe('unavailable');
  });

  it('reports a network failure as unavailable', async () => {
    stubFetch(() => {
      throw new TypeError('Network connection lost.');
    });
    await expect(validateProviderKey('google', KEY, null)).resolves.toMatchObject({
      result: 'unavailable',
      status: null,
    });
  });

  it('reports a timeout as unavailable and waits at most 10 seconds', async () => {
    expect(VALIDATION_TIMEOUT_MILLISECONDS).toBe(10_000);
    stubFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    await expect(validateProviderKey('xai', KEY, null)).resolves.toMatchObject({ result: 'unavailable' });
  });

  it('goes through the gateway when it is configured', async () => {
    const captured = stubFetch(() => new Response('{}', { status: 200 }));
    await validateProviderKey('openai', KEY, { baseURL: GATEWAY_BASE_URL, token: 'vault-gateway-token' });
    await validateProviderKey('google', KEY, { baseURL: GATEWAY_BASE_URL, token: null });
    expect(captured.map((request) => request.url)).toEqual([
      `${GATEWAY_BASE_URL}/openai/models`,
      `${GATEWAY_BASE_URL}/google-ai-studio/v1beta/models?pageSize=1`,
    ]);
    expect(captured[0]?.headers['cf-aig-authorization']).toBe('Bearer vault-gateway-token');
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(captured[1]?.headers).not.toHaveProperty('cf-aig-authorization');
    for (const request of captured) {
      expect(request.url).not.toContain(KEY);
    }
  });

  it('does not call a gateway base that is not https', async () => {
    const captured = stubFetch(() => new Response('{}', { status: 200 }));
    await expect(
      validateProviderKey('openai', KEY, { baseURL: 'http://gateway.example.com/v1/a/b', token: 'vault-gateway-token' }),
    ).resolves.toMatchObject({ result: 'unavailable', status: null });
    expect(captured).toEqual([]);
  });
});
