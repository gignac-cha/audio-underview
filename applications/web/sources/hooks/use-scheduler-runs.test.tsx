import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import { RUN_TIMEOUT_MILLISECONDS } from './scheduler-manager-request.ts';
import { useExecuteScheduler } from './use-scheduler-runs.ts';
import type { ReactNode } from 'react';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(() => ({
      user: { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' },
      credential: 'test-access-token',
      expiresAt: Date.now() + 3_600_000,
    })),
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function respondToExecute(status: number, body: Record<string, unknown>) {
  worker.use(
    http.post(`${SCHEDULER_MANAGER_URL}/schedulers/s1/execute`, () => HttpResponse.json(body, { status })),
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('useExecuteScheduler', () => {
  test('answers the recorded run of a run that ended', async () => {
    respondToExecute(200, { run_id: 'run-1', status: 'completed', result: { count: 3 }, error: null });
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    const execution = await result.current.executeScheduler('s1');

    expect(execution).toEqual({ run_id: 'run-1', status: 'completed', error: null });
  });

  test('answers a run that a Workflow runs as pending on 202', async () => {
    respondToExecute(202, { run_id: 'run-1', status: 'pending', result: null, error: null });
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    const execution = await result.current.executeScheduler('s1');

    expect(execution).toEqual({ run_id: 'run-1', status: 'pending', error: null });
  });

  test.each([408, 422, 500])('answers the recorded run when it failed with status %i', async (status) => {
    respondToExecute(status, { run_id: 'run-1', status: 'failed', result: null, error: 'Stage 0 failed' });
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    const execution = await result.current.executeScheduler('s1');

    expect(execution).toEqual({ run_id: 'run-1', status: 'failed', error: 'Stage 0 failed' });
  });

  test('throws A run is already in progress on 409', async () => {
    respondToExecute(409, { error: 'conflict', error_description: 'A run is already in progress' });
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    await expect(result.current.executeScheduler('s1')).rejects.toThrow('A run is already in progress');
  });

  test('throws the server text of a failure that recorded no run', async () => {
    respondToExecute(500, { error: 'internal_error', error_description: 'Something broke' });
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    await expect(result.current.executeScheduler('s1')).rejects.toThrow('Something broke');
  });

  test('waits as long as the pipeline limit allows', async () => {
    respondToExecute(200, { run_id: 'run-1', status: 'completed', result: null, error: null });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    await result.current.executeScheduler('s1');

    expect(timeout).toHaveBeenCalledWith(RUN_TIMEOUT_MILLISECONDS);
  });

  test('reads the runs, the scheduler and the schedulers list again, whether the run ended well or not', async () => {
    respondToExecute(409, { error: 'conflict', error_description: 'A run is already in progress' });
    const { queryClient, wrapper } = createWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = await renderHook(() => useExecuteScheduler(), { wrapper });

    await result.current.executeScheduler('s1').catch(() => undefined);

    await vi.waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers', 's1', 'runs'] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers', 's1'], exact: true });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers'], exact: true });
    });
  });
});
