import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { useCreateCrawler, useListCrawlers, useDeleteCrawler, useGetCrawler, useUpdateCrawler } from './use-crawler-manager.ts';
import { worker } from '../tests/mocks/browser.ts';
import type { ReactNode } from 'react';

const MANAGER_URL = 'http://localhost:8888';

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

describe('useCreateCrawler', () => {
  test('creates a crawler and returns data', async () => {
    const mockCrawler = { id: 'c1', name: 'Test Crawler', url_pattern: '^https://example\\.com', code: 'return {}', user_id: 'u1', created_at: '2024-01-01' };
    worker.use(
      http.post(`${MANAGER_URL}/crawlers`, async ({ request }) => {
        const authorizationHeader = request.headers.get('Authorization');
        if (authorizationHeader !== 'Bearer test-access-token') {
          return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
        }
        return HttpResponse.json(mockCrawler);
      }),
    );

    const { result } = await renderHook(() => useCreateCrawler(), {
      wrapper: createWrapper(),
    });

    const created = await result.current.createCrawler({
      name: 'Test Crawler',
      url_pattern: '^https://example\\.com',
      code: 'return {}',
    });

    expect(created).toEqual(mockCrawler);
  });

  test('includes Authorization header', async () => {
    let capturedAuthorization: string | null = null;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers`, async ({ request }) => {
        capturedAuthorization = request.headers.get('Authorization');
        return HttpResponse.json({ id: 'c1', name: 'test', url_pattern: '', code: '', user_id: 'u1', created_at: '' });
      }),
    );

    const { result } = await renderHook(() => useCreateCrawler(), {
      wrapper: createWrapper(),
    });

    await result.current.createCrawler({ name: 'test', url_pattern: '', code: '' });
    expect(capturedAuthorization).toBe('Bearer test-access-token');
  });

  test('throws on server error', async () => {
    worker.use(
      http.post(`${MANAGER_URL}/crawlers`, async () => {
        return HttpResponse.json({ error: 'server_error', error_description: 'DB unavailable' }, { status: 500 });
      }),
    );

    const { result } = await renderHook(() => useCreateCrawler(), {
      wrapper: createWrapper(),
    });

    await expect(
      result.current.createCrawler({ name: 'test', url_pattern: '', code: '' }),
    ).rejects.toThrow('DB unavailable');
  });
});

describe('useListCrawlers', () => {
  test('fetches crawlers list', async () => {
    const mockData = {
      data: [
        { id: 'c1', name: 'Crawler 1', url_pattern: '', code: '', user_id: 'u1', created_at: '' },
        { id: 'c2', name: 'Crawler 2', url_pattern: '', code: '', user_id: 'u1', created_at: '' },
      ],
      total: 2,
      offset: 0,
      limit: 20,
    };

    worker.use(
      http.get(`${MANAGER_URL}/crawlers`, async () => {
        return HttpResponse.json(mockData);
      }),
    );

    const { result } = await renderHook(() => useListCrawlers(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.crawlers).toHaveLength(2);
    });

    expect(result.current.crawlers[0].name).toBe('Crawler 1');
    expect(result.current.crawlers[1].name).toBe('Crawler 2');
  });

  test('sends offset and limit as query parameters', async () => {
    let capturedURL = '';
    worker.use(
      http.get(`${MANAGER_URL}/crawlers`, async ({ request }) => {
        capturedURL = request.url;
        return HttpResponse.json({ data: [], total: 0, offset: 0, limit: 20 });
      }),
    );

    const { result } = await renderHook(() => useListCrawlers(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(capturedURL).toContain('offset=0');
    expect(capturedURL).toContain('limit=20');
  });

  test('includes Authorization header in list request', async () => {
    let capturedAuthorization: string | null = null;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers`, async ({ request }) => {
        capturedAuthorization = request.headers.get('Authorization');
        return HttpResponse.json({ data: [], total: 0, offset: 0, limit: 20 });
      }),
    );

    const { result } = await renderHook(() => useListCrawlers(), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(capturedAuthorization).toBe('Bearer test-access-token');
  });
});

describe('useDeleteCrawler', () => {
  test('deletes a crawler successfully', async () => {
    worker.use(
      http.delete(`${MANAGER_URL}/crawlers/c1`, async () => {
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = await renderHook(() => useDeleteCrawler(), {
      wrapper: createWrapper(),
    });

    await result.current.deleteCrawler('c1');

    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });
  });

  test('throws on delete error', async () => {
    worker.use(
      http.delete(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Crawler not found' }, { status: 404 });
      }),
    );

    const { result } = await renderHook(() => useDeleteCrawler(), {
      wrapper: createWrapper(),
    });

    await expect(result.current.deleteCrawler('c1')).rejects.toThrow('Crawler not found');
  });

  test('includes Authorization header in delete request', async () => {
    let capturedAuthorization: string | null = null;
    worker.use(
      http.delete(`${MANAGER_URL}/crawlers/c1`, async ({ request }) => {
        capturedAuthorization = request.headers.get('Authorization');
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { result } = await renderHook(() => useDeleteCrawler(), {
      wrapper: createWrapper(),
    });

    await result.current.deleteCrawler('c1');
    expect(capturedAuthorization).toBe('Bearer test-access-token');
  });
});

describe('useGetCrawler', () => {
  test('fetches a single crawler by id', async () => {
    const mockCrawler = {
      id: 'c1',
      user_uuid: 'u1',
      name: 'Detail Crawler',
      type: 'web',
      url_pattern: '^https://example\\.com',
      code: '(body) => body.length',
      input_schema: { body: 'string' },
      output_schema: {},
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    };
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    const { result } = await renderHook(() => useGetCrawler('c1'), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.crawler).toBeDefined();
    });

    expect(result.current.crawler).toEqual(mockCrawler);
  });

  test('does not fetch when id is undefined', async () => {
    let requestCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/:id`, async () => {
        requestCount += 1;
        return HttpResponse.json({});
      }),
    );

    const { result } = await renderHook(() => useGetCrawler(undefined), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.crawler).toBeUndefined();
    expect(requestCount).toBe(0);
  });

  test('throws on server error', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(
          { error: 'not_found', error_description: 'Crawler not found' },
          { status: 404 },
        );
      }),
    );

    const { result } = await renderHook(() => useGetCrawler('c1'), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.error).toBeDefined();
    });

    expect(result.current.error?.message).toBe('Crawler not found');
  });

  test('includes Authorization header in GET request', async () => {
    let capturedAuthorization: string | null = null;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async ({ request }) => {
        capturedAuthorization = request.headers.get('Authorization');
        return HttpResponse.json({ id: 'c1' });
      }),
    );

    const { result } = await renderHook(() => useGetCrawler('c1'), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.crawler).toBeDefined();
    });

    expect(capturedAuthorization).toBe('Bearer test-access-token');
  });
});

describe('useUpdateCrawler', () => {
  test('updates a crawler and returns the new row', async () => {
    const updated = {
      id: 'c1',
      user_uuid: 'u1',
      name: 'Renamed',
      type: 'web',
      url_pattern: '^https://example\\.com',
      code: '(body) => 1',
      input_schema: { body: 'string' },
      output_schema: {},
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-03T00:00:00Z',
    };
    worker.use(
      http.put(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(updated);
      }),
    );

    const { result } = await renderHook(() => useUpdateCrawler(), {
      wrapper: createWrapper(),
    });

    const response = await result.current.updateCrawler({
      id: 'c1',
      name: 'Renamed',
      type: 'web',
      url_pattern: '^https://example\\.com',
      code: '(body) => 1',
      output_schema: {},
    });

    expect(response).toEqual(updated);
  });

  test('sends PUT body without id field', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    worker.use(
      http.put(`${MANAGER_URL}/crawlers/c1`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'c1',
          user_uuid: 'u1',
          name: 'X',
          type: 'web',
          url_pattern: '',
          code: '',
          input_schema: {},
          output_schema: {},
          created_at: '',
          updated_at: '',
        });
      }),
    );

    const { result } = await renderHook(() => useUpdateCrawler(), {
      wrapper: createWrapper(),
    });

    await result.current.updateCrawler({
      id: 'c1',
      name: 'X',
      type: 'web',
      url_pattern: '',
      code: '',
      output_schema: {},
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody && 'id' in capturedBody).toBe(false);
    expect(capturedBody?.name).toBe('X');
  });

  test('throws on update error', async () => {
    worker.use(
      http.put(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(
          { error: 'invalid_request', error_description: 'Name too long' },
          { status: 400 },
        );
      }),
    );

    const { result } = await renderHook(() => useUpdateCrawler(), {
      wrapper: createWrapper(),
    });

    await expect(
      result.current.updateCrawler({
        id: 'c1',
        name: 'X',
        type: 'web',
        url_pattern: '',
        code: '',
        output_schema: {},
      }),
    ).rejects.toThrow('Name too long');
  });

  test('includes Authorization header in PUT request', async () => {
    let capturedAuthorization: string | null = null;
    worker.use(
      http.put(`${MANAGER_URL}/crawlers/c1`, async ({ request }) => {
        capturedAuthorization = request.headers.get('Authorization');
        return HttpResponse.json({
          id: 'c1',
          user_uuid: 'u1',
          name: 'X',
          type: 'web',
          url_pattern: '^.*$',
          code: '(b)=>b',
          input_schema: { body: 'string' },
          output_schema: {},
          created_at: '',
          updated_at: '',
        });
      }),
    );

    const { result } = await renderHook(() => useUpdateCrawler(), {
      wrapper: createWrapper(),
    });

    await result.current.updateCrawler({
      id: 'c1',
      name: 'X',
      type: 'web',
      url_pattern: '^.*$',
      code: '(b)=>b',
    });

    expect(capturedAuthorization).toBe('Bearer test-access-token');
  });
});
