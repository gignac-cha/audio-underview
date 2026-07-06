import { describe, expect, it, vi } from 'vitest';
import {
  CodeRunnerExecutionError,
  createHTTPCodeRunnerClient,
} from '../sources/code-runner-client.ts';

const webRequest = {
  type: 'web',
  mode: 'run',
  url: 'https://example.com',
  code: '(body) => body',
} as const;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const createClient = (fetchMock: typeof fetch) =>
  createHTTPCodeRunnerClient({
    baseURL: 'https://runner.example.com',
    fetchImplementation: fetchMock,
    delay: () => Promise.resolve(), // 테스트에서는 backoff 대기 생략
  });

describe('createHTTPCodeRunnerClient', () => {
  it('POSTs to /run with the bearer token and returns the parsed result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ type: 'web', mode: 'run', result: { title: 'ok' } }),
    );
    const client = createClient(fetchMock);

    const result = await client.run(webRequest, 'token-1');

    expect(result.result).toEqual({ title: 'ok' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://runner.example.com/run');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-1');
  });

  it('retries network errors up to 2 times then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockResolvedValue(jsonResponse({ type: 'web', mode: 'run', result: 1 }));

    const result = await createClient(fetchMock).run(webRequest, 'token');
    expect(result.result).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 5xx responses and fails after exhausting retries', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ error: 'server_error', error_description: 'down' }, 503)),
      );

    await expect(createClient(fetchMock).run(webRequest, 'token')).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'server_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('fails 4xx immediately without retry and reads the error field (quirk 수정)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: 'execution_failed', error_description: 'user code threw' }, 422),
      );

    await expect(createClient(fetchMock).run(webRequest, 'token')).rejects.toMatchObject({
      errorCode: 'execution_failed',
      errorDescription: 'user code threw',
      statusCode: 422,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a 200 response without a result key (undefined 반환 계약)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ type: 'data', mode: 'run' }));
    const result = await createClient(fetchMock).run(
      { type: 'data', mode: 'run', data: null, code: '() => undefined' },
      'token',
    );
    expect(result.result).toBeUndefined();
  });

  it('rejects malformed 2xx payloads as invalid_response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ type: 'web' }));
    await expect(createClient(fetchMock).run(webRequest, 'token')).rejects.toMatchObject({
      errorCode: 'invalid_response',
    });
  });

  it('formats error messages with the legacy shape', () => {
    const error = new CodeRunnerExecutionError('execution_failed', 'boom', 422);
    expect(error.message).toBe('CodeRunner error 422: [execution_failed] boom');
  });
});
