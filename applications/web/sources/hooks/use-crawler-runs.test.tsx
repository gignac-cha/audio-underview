import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import {
  useDownloadCrawlerFile,
  useGetCrawlerRun,
  useListCrawlerRuns,
  useRunCrawler,
} from './use-crawler-runs.ts';
import { worker } from '../tests/mocks/browser.ts';
import type { ReactNode } from 'react';

const MANAGER_URL = 'http://localhost:8888';
const CRAWLER_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';

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
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function completedRun(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    status: 'completed',
    result: { title: 'Hello' },
    logs: [{ level: 'info', message: 'fetched', timestamp: '2024-01-01T00:00:00.000Z' }],
    logs_truncated: false,
    ...overrides,
  };
}

function failedRun(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    status: 'failed',
    error: 'execution_failed',
    error_description: 'TypeError: body is not a function',
    logs: [{ level: 'error', message: 'boom', timestamp: '2024-01-01T00:00:00.000Z' }],
    logs_truncated: true,
    ...overrides,
  };
}

function summary(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    crawler_id: CRAWLER_ID,
    kind: 'direct',
    type: 'web',
    status: 'completed',
    error_code: null,
    logs_truncated: false,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:02.000Z',
    created_at: '2024-01-01T00:00:02.000Z',
  };
}

describe('useRunCrawler — routes', () => {
  test('a saved crawler is run with POST /crawlers/:id/runs and the input', async () => {
    let captured: { method: string; authorization: string | null; body: unknown } | undefined;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async ({ request }) => {
        captured = {
          method: request.method,
          authorization: request.headers.get('Authorization'),
          body: await request.json(),
        };
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID, input: { url: 'https://example.com' } });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(captured).toEqual({
      method: 'POST',
      authorization: 'Bearer test-access-token',
      body: { input: { url: 'https://example.com' } },
    });
    expect(result.current.result).toMatchObject({ status: 'completed', run_id: RUN_ID, result: { title: 'Hello' } });
  });

  test('a saved crawler without an input sends no input', async () => {
    let capturedBody: unknown;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(capturedBody).toEqual({});
  });

  test('a saved crawler with changes is run with POST /crawlers/:id/test-runs and the draft', async () => {
    let captured: { method: string; authorization: string | null; body: unknown } | undefined;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/test-runs`, async ({ request }) => {
        captured = {
          method: request.method,
          authorization: request.headers.get('Authorization'),
          body: await request.json(),
        };
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({
      target: 'saved-draft',
      crawlerID: CRAWLER_ID,
      code: '(body) => body.length',
      url_pattern: '^https://example\\.com',
      environment_variable_names: ['API_TOKEN'],
      input: { url: 'https://example.com' },
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(captured).toEqual({
      method: 'POST',
      authorization: 'Bearer test-access-token',
      body: {
        code: '(body) => body.length',
        url_pattern: '^https://example\\.com',
        environment_variable_names: ['API_TOKEN'],
        input: { url: 'https://example.com' },
      },
    });
  });

  test('a draft leaves out the fields it does not set', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/test-runs`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved-draft', crawlerID: CRAWLER_ID, code: 'return 1' });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(capturedBody).toEqual({ code: 'return 1' });
  });

  test('a crawler that is not saved is run with POST /crawler-test-runs and its type', async () => {
    let captured: { method: string; body: unknown } | undefined;
    worker.use(
      http.post(`${MANAGER_URL}/crawler-test-runs`, async ({ request }) => {
        captured = { method: request.method, body: await request.json() };
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({
      target: 'new-draft',
      type: 'data',
      code: 'return {}',
      input_schema: { userIds: 'string[]' },
      environment_variable_names: [],
      input: { userIds: ['a'] },
    });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(captured).toEqual({
      method: 'POST',
      body: {
        type: 'data',
        code: 'return {}',
        input_schema: { userIds: 'string[]' },
        environment_variable_names: [],
        input: { userIds: ['a'] },
      },
    });
  });
});

describe('useRunCrawler — results and errors', () => {
  test('a run that failed is a result even when the status is 422', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json(failedRun(), { status: 422 });
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.error).toBeUndefined();
    expect(result.current.result).toMatchObject({
      status: 'failed',
      error: 'execution_failed',
      error_description: 'TypeError: body is not a function',
      logs_truncated: true,
    });
  });

  test.each([400, 422, 502, 504])('a failed run answered with %i is still a result', async (status) => {
    worker.use(
      http.post(`${MANAGER_URL}/crawler-test-runs`, async () => {
        return HttpResponse.json(failedRun({ run_id: null }), { status });
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'new-draft', type: 'web', code: 'x' });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.result).toMatchObject({ status: 'failed', run_id: null });
  });

  test('an error without a run throws its error_description', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/test-runs`, async () => {
        return HttpResponse.json(
          { error: 'invalid_request', error_description: "Field 'code' must not be empty" },
          { status: 400 },
        );
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved-draft', crawlerID: CRAWLER_ID, code: '' });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.error?.message).toBe("Field 'code' must not be empty");
    expect(result.current.result).toBeUndefined();
  });

  test('a 503 because the environment variables cannot be read throws its error_description', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.error?.message).toBe('Environment variables are not available right now');
  });

  test('a 404 throws its error_description', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Crawler not found' }, { status: 404 });
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.error?.message).toBe('Crawler not found');
  });

  test('a 2xx answer of another shape throws', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.error?.message).toBe('The server sent a response this page cannot read.');
  });

  test('an answer that is not JSON throws with the status', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return new HttpResponse('Bad Gateway', { status: 502 });
      }),
    );

    const { result } = await renderHook(() => useRunCrawler(), { wrapper: createWrapper() });

    result.current.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    expect(result.current.error?.message).toBe('Request failed with status 502');
  });
});

describe('useRunCrawler — run history', () => {
  test('a finished run reloads the list of that crawler', async () => {
    let listCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        listCount += 1;
        return HttpResponse.json({ data: [summary(listCount)], total: 1, offset: 0, limit: 20 });
      }),
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/test-runs`, async () => {
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(
      () => ({ runs: useListCrawlerRuns(CRAWLER_ID), run: useRunCrawler() }),
      { wrapper: createWrapper() },
    );

    await vi.waitFor(() => {
      expect(result.current.runs.runs).toHaveLength(1);
    });
    expect(listCount).toBe(1);

    result.current.run.runCrawler({ target: 'saved-draft', crawlerID: CRAWLER_ID, code: 'return 1' });

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
    });
  });

  test('a failed run reloads the list as well', async () => {
    let listCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        listCount += 1;
        return HttpResponse.json({ data: [], total: 0, offset: 0, limit: 20 });
      }),
      http.post(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json(failedRun(), { status: 422 });
      }),
    );

    const { result } = await renderHook(
      () => ({ runs: useListCrawlerRuns(CRAWLER_ID), run: useRunCrawler() }),
      { wrapper: createWrapper() },
    );

    await vi.waitFor(() => {
      expect(listCount).toBe(1);
    });

    result.current.run.runCrawler({ target: 'saved', crawlerID: CRAWLER_ID });

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
    });
  });

  test('a run without a crawler reloads the list of unsaved runs only', async () => {
    let crawlerListCount = 0;
    let unsavedListCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        crawlerListCount += 1;
        return HttpResponse.json({ data: [], total: 0, offset: 0, limit: 20 });
      }),
      http.get(`${MANAGER_URL}/crawler-test-runs`, async () => {
        unsavedListCount += 1;
        return HttpResponse.json({ data: [], total: 0, offset: 0, limit: 20 });
      }),
      http.post(`${MANAGER_URL}/crawler-test-runs`, async () => {
        return HttpResponse.json(completedRun());
      }),
    );

    const { result } = await renderHook(
      () => ({ crawlerRuns: useListCrawlerRuns(CRAWLER_ID), unsavedRuns: useListCrawlerRuns(null), run: useRunCrawler() }),
      { wrapper: createWrapper() },
    );

    await vi.waitFor(() => {
      expect(crawlerListCount).toBe(1);
      expect(unsavedListCount).toBe(1);
    });

    result.current.run.runCrawler({ target: 'new-draft', type: 'web', code: 'return 1' });

    await vi.waitFor(() => {
      expect(unsavedListCount).toBe(2);
    });
    expect(crawlerListCount).toBe(1);
  });
});

describe('useListCrawlerRuns', () => {
  test('lists the runs of a crawler with GET /crawlers/:id/runs', async () => {
    let captured: { url: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async ({ request }) => {
        captured = { url: request.url, authorization: request.headers.get('Authorization') };
        return HttpResponse.json({ data: [summary(1), summary(2)], total: 2, offset: 0, limit: 20 });
      }),
    );

    const { result } = await renderHook(() => useListCrawlerRuns(CRAWLER_ID), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.runs).toHaveLength(2);
    });

    expect(captured?.url).toContain('offset=0');
    expect(captured?.url).toContain('limit=20');
    expect(captured?.authorization).toBe('Bearer test-access-token');
    expect(result.current.hasNextPage).toBe(false);
  });

  test('lists the test runs of unsaved crawlers with GET /crawler-test-runs', async () => {
    let capturedURL = '';
    worker.use(
      http.get(`${MANAGER_URL}/crawler-test-runs`, async ({ request }) => {
        capturedURL = request.url;
        return HttpResponse.json({
          data: [{ ...summary(1), crawler_id: null, kind: 'test' }],
          total: 1,
          offset: 0,
          limit: 20,
        });
      }),
    );

    const { result } = await renderHook(() => useListCrawlerRuns(null), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.runs).toHaveLength(1);
    });

    expect(new URL(capturedURL).pathname).toBe('/crawler-test-runs');
    expect(result.current.runs[0].kind).toBe('test');
    expect(result.current.runs[0].crawler_id).toBeNull();
  });

  test('loads the next page after the first twenty', async () => {
    const offsets: string[] = [];
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get('offset'));
        offsets.push(String(offset));
        const data = Array.from({ length: offset === 0 ? 20 : 5 }, (_, index) => summary(offset + index));
        return HttpResponse.json({ data, total: 25, offset, limit: 20 });
      }),
    );

    const { result } = await renderHook(() => useListCrawlerRuns(CRAWLER_ID), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.runs).toHaveLength(20);
    });
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();

    await vi.waitFor(() => {
      expect(result.current.runs).toHaveLength(25);
    });
    expect(offsets).toEqual(['0', '20']);
    expect(result.current.hasNextPage).toBe(false);
  });

  test('exposes the error_description of a failed request', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Crawler not found' }, { status: 404 });
      }),
    );

    const { result } = await renderHook(() => useListCrawlerRuns(CRAWLER_ID), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('Crawler not found');
    });
  });
});

describe('useGetCrawlerRun', () => {
  const detail = {
    ...summary(1),
    id: RUN_ID,
    user_uuid: 'u1',
    result: { title: 'Hello' },
    error: null,
    logs: [{ level: 'info', message: 'fetched', timestamp: '2024-01-01T00:00:00.000Z' }],
    code: null,
  };

  test('gets one run of a crawler with GET /crawlers/:id/runs/:runID', async () => {
    let captured: { pathname: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs/${RUN_ID}`, async ({ request }) => {
        captured = {
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get('Authorization'),
        };
        return HttpResponse.json(detail);
      }),
    );

    const { result } = await renderHook(() => useGetCrawlerRun(CRAWLER_ID, RUN_ID), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.run).toBeDefined();
    });

    expect(captured).toEqual({
      pathname: `/crawlers/${CRAWLER_ID}/runs/${RUN_ID}`,
      authorization: 'Bearer test-access-token',
    });
    expect(result.current.run?.result).toEqual({ title: 'Hello' });
    expect(result.current.run?.logs).toHaveLength(1);
  });

  test('gets one run of an unsaved crawler with GET /crawler-test-runs/:runID', async () => {
    let capturedPathname = '';
    worker.use(
      http.get(`${MANAGER_URL}/crawler-test-runs/${RUN_ID}`, async ({ request }) => {
        capturedPathname = new URL(request.url).pathname;
        return HttpResponse.json({ ...detail, crawler_id: null, kind: 'test', code: 'return 1' });
      }),
    );

    const { result } = await renderHook(() => useGetCrawlerRun(null, RUN_ID), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.run).toBeDefined();
    });

    expect(capturedPathname).toBe(`/crawler-test-runs/${RUN_ID}`);
    expect(result.current.run?.code).toBe('return 1');
  });

  test('does not fetch while the run id is undefined', async () => {
    let requested = false;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs/:runID`, async () => {
        requested = true;
        return HttpResponse.json(detail);
      }),
    );

    const { result } = await renderHook(() => useGetCrawlerRun(CRAWLER_ID, undefined), { wrapper: createWrapper() });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(requested).toBe(false);
    expect(result.current.run).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  test('exposes the error_description of a 404', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs/${RUN_ID}`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Crawler run not found' }, { status: 404 });
      }),
    );

    const { result } = await renderHook(() => useGetCrawlerRun(CRAWLER_ID, RUN_ID), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('Crawler run not found');
    });
  });
});

describe('useDownloadCrawlerFile', () => {
  function captureSavedFile() {
    const saved: { fileName: string; content: Promise<string> | undefined } = { fileName: '', content: undefined };
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
      saved.content = (object as Blob).text();
      return 'blob:test';
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.fileName = this.download;
    });
    return {
      saved,
      restore: () => {
        createObjectURL.mockRestore();
        click.mockRestore();
      },
    };
  }

  test('saves GET /files/:id under the name of the reference', async () => {
    let captured: { pathname: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/files/${FILE_ID}`, async ({ request }) => {
        captured = {
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get('Authorization'),
        };
        return new HttpResponse('file content', { headers: { 'Content-Type': 'text/plain' } });
      }),
    );
    const { saved, restore } = captureSavedFile();

    try {
      const { result } = await renderHook(() => useDownloadCrawlerFile(), { wrapper: createWrapper() });

      result.current.downloadFile({ fileID: FILE_ID, fileName: 'report.txt' });

      await vi.waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      expect(captured).toEqual({ pathname: `/files/${FILE_ID}`, authorization: 'Bearer test-access-token' });
      expect(saved.fileName).toBe('report.txt');
      expect(await saved.content).toBe('file content');
    } finally {
      restore();
    }
  });

  test('saves a file whose reference has no name under its id', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/files/${FILE_ID}`, async () => {
        return new HttpResponse('file content');
      }),
    );
    const { saved, restore } = captureSavedFile();

    try {
      const { result } = await renderHook(() => useDownloadCrawlerFile(), { wrapper: createWrapper() });

      result.current.downloadFile({ fileID: FILE_ID, fileName: null });

      await vi.waitFor(() => {
        expect(result.current.status).toBe('success');
      });

      expect(saved.fileName).toBe(FILE_ID);
    } finally {
      restore();
    }
  });

  test('a 404 says the file was not found or expired and saves nothing', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/files/${FILE_ID}`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'File not found' }, { status: 404 });
      }),
    );
    const { saved, restore } = captureSavedFile();

    try {
      const { result } = await renderHook(() => useDownloadCrawlerFile(), { wrapper: createWrapper() });

      result.current.downloadFile({ fileID: FILE_ID, fileName: 'report.txt' });

      await vi.waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.error?.message).toBe('File not found or expired');
      expect(saved.fileName).toBe('');
    } finally {
      restore();
    }
  });

  test('another error throws its error_description', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/files/${FILE_ID}`, async () => {
        return HttpResponse.json({ error: 'server_error', error_description: 'An unexpected error occurred' }, { status: 500 });
      }),
    );
    const { restore } = captureSavedFile();

    try {
      const { result } = await renderHook(() => useDownloadCrawlerFile(), { wrapper: createWrapper() });

      result.current.downloadFile({ fileID: FILE_ID, fileName: null });

      await vi.waitFor(() => {
        expect(result.current.status).toBe('error');
      });

      expect(result.current.error?.message).toBe('An unexpected error occurred');
    } finally {
      restore();
    }
  });
});
