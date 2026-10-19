import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import { RUN_TIMEOUT_MILLISECONDS } from './scheduler-manager-request.ts';
import { useExecuteScheduler, useGetRun, useGetStageRun, useListRuns } from './use-scheduler-runs.ts';
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

function createWrapper(staleTimeMilliseconds?: number) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: staleTimeMilliseconds }, mutations: { retry: false } },
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

describe('useListRuns', () => {
  const unavailable = { error: 'unavailable', error_description: 'Service unavailable' };

  function respondToList(respond: () => Response) {
    worker.use(http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs`, respond));
  }

  function listOf(...ids: string[]) {
    return HttpResponse.json({
      data: ids.map((id) => ({ id, status: 'completed' })),
      total: ids.length,
      offset: 0,
      limit: 20,
    });
  }

  test('says error and no runs when the first read fails', async () => {
    respondToList(() => HttpResponse.json(unavailable, { status: 503 }));
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useListRuns('s1'), { wrapper });

    await vi.waitFor(() => expect(result.current.error?.message).toBe('Service unavailable'));
    expect(result.current.refreshError).toBeUndefined();
    expect(result.current.runs).toEqual([]);
  });

  test('keeps the runs and says refreshError when a refresh fails, until a refresh works', async () => {
    let failing = false;
    respondToList(() => (failing ? HttpResponse.json(unavailable, { status: 503 }) : listOf('run-1')));
    const { queryClient, wrapper } = createWrapper();
    const { result } = await renderHook(() => useListRuns('s1'), { wrapper });
    await vi.waitFor(() => expect(result.current.runs).toHaveLength(1));

    failing = true;
    await queryClient.invalidateQueries({ queryKey: ['schedulers', 's1', 'runs'] });

    await vi.waitFor(() => expect(result.current.refreshError?.message).toBe('Service unavailable'));
    expect(result.current.error).toBeUndefined();
    expect(result.current.runs).toHaveLength(1);

    failing = false;
    await queryClient.invalidateQueries({ queryKey: ['schedulers', 's1', 'runs'] });

    await vi.waitFor(() => expect(result.current.refreshError).toBeUndefined());
    expect(result.current.runs).toHaveLength(1);
  });
});

describe('useGetRun', () => {
  function respondToRun(respond: () => Response | Promise<Response>) {
    worker.use(http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1`, respond));
  }

  test('reads the run again each time it is opened, even when the answer in the cache is fresh', async () => {
    let status = 'running';
    let requests = 0;
    respondToRun(() => {
      requests += 1;
      return HttpResponse.json({ id: 'run-1', status, stage_runs: [] });
    });
    // As fresh as the staleness of the page makes an answer
    const { wrapper } = createWrapper(5 * 60 * 1000);

    const first = await renderHook(() => useGetRun('s1', 'run-1', { refreshIntervalMilliseconds: 10_000 }), { wrapper });
    await vi.waitFor(() => expect(first.result.current.run?.status).toBe('running'));
    await first.unmount();
    expect(requests).toBe(1);

    status = 'completed';
    const second = await renderHook(() => useGetRun('s1', 'run-1', { refreshIntervalMilliseconds: 10_000 }), { wrapper });

    await vi.waitFor(() => expect(second.result.current.run?.status).toBe('completed'));
    expect(requests).toBe(2);
  });

  test('says the run was not read since it was opened while the answer in the cache is the one of an earlier opening', async () => {
    let status = 'running';
    let release: () => void = () => undefined;
    let hold: Promise<void> | undefined;
    respondToRun(async () => {
      await hold;
      return HttpResponse.json({ id: 'run-1', status, stage_runs: [] });
    });
    const { wrapper } = createWrapper(5 * 60 * 1000);

    const first = await renderHook(() => useGetRun('s1', 'run-1', { refreshIntervalMilliseconds: 10_000 }), { wrapper });
    await vi.waitFor(() => expect(first.result.current.hasReadSinceOpened).toBe(true));
    await first.unmount();

    status = 'completed';
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const second = await renderHook(() => useGetRun('s1', 'run-1', { refreshIntervalMilliseconds: 10_000 }), { wrapper });

    expect(second.result.current.run?.status).toBe('running');
    expect(second.result.current.hasReadSinceOpened).toBe(false);

    release();

    await vi.waitFor(() => expect(second.result.current.hasReadSinceOpened).toBe(true));
    expect(second.result.current.run?.status).toBe('completed');
  });
});

describe('useGetStageRun', () => {
  const unavailable = { error: 'unavailable', error_description: 'Service unavailable' };

  function respondToStageRun(respond: () => Response) {
    worker.use(http.get(`${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1/stage-runs/stage-run-1`, respond));
  }

  test('says error and no stage run when the first read fails', async () => {
    respondToStageRun(() => HttpResponse.json(unavailable, { status: 503 }));
    const { wrapper } = createWrapper();
    const { result } = await renderHook(() => useGetStageRun('s1', 'run-1', 'stage-run-1', false), { wrapper });

    await vi.waitFor(() => expect(result.current.error?.message).toBe('Service unavailable'));
    expect(result.current.refreshError).toBeUndefined();
    expect(result.current.stageRun).toBeUndefined();
  });

  test('keeps the stage run and says refreshError when the read made at the end of its stage fails', async () => {
    let failing = false;
    respondToStageRun(() => {
      return failing
        ? HttpResponse.json(unavailable, { status: 503 })
        : HttpResponse.json({ id: 'stage-run-1', status: 'running', input: { url: 'https://example.com' } });
    });
    const { wrapper } = createWrapper();
    const { result, rerender } = await renderHook(
      (properties) => useGetStageRun('s1', 'run-1', 'stage-run-1', properties?.isFinished ?? false),
      { wrapper, initialProps: { isFinished: false } },
    );
    await vi.waitFor(() => expect(result.current.stageRun?.input).toEqual({ url: 'https://example.com' }));

    failing = true;
    await rerender({ isFinished: true });

    await vi.waitFor(() => expect(result.current.refreshError?.message).toBe('Service unavailable'));
    expect(result.current.error).toBeUndefined();
    expect(result.current.stageRun?.input).toEqual({ url: 'https://example.com' });
  });
});
