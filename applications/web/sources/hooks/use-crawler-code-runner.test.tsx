import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { useCrawlerCodeRunner } from './use-crawler-code-runner.ts';
import { worker } from '../tests/mocks/browser.ts';
import type { ReactNode } from 'react';

const RUNNER_URL = 'http://localhost:9999';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useCrawlerCodeRunner', () => {

  test('initial status is idle', async () => {
    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test('logs info entries when starting execution', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json({ type: 'test', result: { data: 'ok' } });
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', message: 'Starting test execution...' }),
      );
    });
  });

  test('logs URL being fetched', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json({ type: 'test', result: { data: 'ok' } });
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', message: 'Fetching https://example.com' }),
      );
    });
  });

  test('logs success on successful execution', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json({ type: 'test', result: { message: 'hello' } });
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'success', message: 'Execution completed successfully' }),
      );
    });
  });

  test('returns result data on success', async () => {
    const mockResult = { type: 'test', result: { message: 'hello' } };
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json(mockResult);
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(result.current.result).toEqual(mockResult);
    });
  });

  test('logs error on failed execution', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json(
          { error: 'execution_error', error_description: 'Code timed out' },
          { status: 500 },
        );
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(onLog).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error', message: 'Execution failed' }),
      );
    });
  });

  test('parses structured error from response', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json(
          { error: 'execution_error', error_description: 'Code timed out' },
          { status: 500 },
        );
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(result.current.error).toBeTruthy();
      expect(result.current.error?.message).toContain('execution_error');
      expect(result.current.error?.message).toContain('Code timed out');
    });
  });

  test('falls back to status code error for non-parseable responses', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json({ random: 'stuff' }, { status: 502 });
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(result.current.error).toBeTruthy();
      expect(result.current.error?.message).toContain('502');
    });
  });

  test('reset clears error and result', async () => {
    worker.use(
      http.post(`${RUNNER_URL}/run`, async () => {
        return HttpResponse.json({ type: 'test', result: { ok: true } });
      }),
    );

    const onLog = vi.fn();
    const { result } = await renderHook(() => useCrawlerCodeRunner({ onLog }), {
      wrapper: createWrapper(),
    });

    result.current.runTest('https://example.com', 'return {}');

    await vi.waitFor(() => {
      expect(result.current.result).not.toBeNull();
    });

    result.current.reset();

    await vi.waitFor(() => {
      expect(result.current.result).toBeNull();
      expect(result.current.status).toBe('idle');
    });
  });
});
