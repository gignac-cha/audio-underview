import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import {
  useDeleteEnvironmentVariable,
  useListEnvironmentVariables,
  useSetEnvironmentVariable,
} from './use-environment-variables.ts';
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient = createQueryClient()) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function summary(name: string) {
  return { name, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z' };
}

describe('useListEnvironmentVariables', () => {
  test('lists the names with GET /environment-variables', async () => {
    let captured: { method: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async ({ request }) => {
        captured = { method: request.method, authorization: request.headers.get('Authorization') };
        return HttpResponse.json({ data: [summary('API_TOKEN'), summary('BLOG_A_TOKEN')] });
      }),
    );

    const { result } = await renderHook(() => useListEnvironmentVariables(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.environmentVariables).toHaveLength(2);
    });

    expect(captured).toEqual({ method: 'GET', authorization: 'Bearer test-access-token' });
    expect(result.current.environmentVariables.map(({ name }) => name)).toEqual(['API_TOKEN', 'BLOG_A_TOKEN']);
    expect(result.current.isLoaded).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  test('does not request the list while it is disabled', async () => {
    let requested = false;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        requested = true;
        return HttpResponse.json({ data: [] });
      }),
    );

    const { result } = await renderHook(() => useListEnvironmentVariables({ enabled: false }), {
      wrapper: createWrapper(),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(requested).toBe(false);
    expect(result.current.isLoaded).toBe(false);
    expect(result.current.environmentVariables).toEqual([]);
  });

  test('exposes the error_description of a 503 when the storage is not available', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    const { result } = await renderHook(() => useListEnvironmentVariables(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('Environment variables are not available right now');
    });
    expect(result.current.isLoaded).toBe(false);
  });

  test('rejects an answer of another shape', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        return HttpResponse.json({ names: ['API_TOKEN'] });
      }),
    );

    const { result } = await renderHook(() => useListEnvironmentVariables(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('The server sent a response this page cannot read.');
    });
  });
});

describe('useSetEnvironmentVariable', () => {
  test('sets a variable with PUT /environment-variables/:name and the value', async () => {
    let captured: { method: string; pathname: string; authorization: string | null; body: unknown } | undefined;
    worker.use(
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async ({ request }) => {
        captured = {
          method: request.method,
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get('Authorization'),
          body: await request.json(),
        };
        return HttpResponse.json(summary('API_TOKEN'), { status: 201 });
      }),
    );

    const { result } = await renderHook(() => useSetEnvironmentVariable(), { wrapper: createWrapper() });

    const stored = await result.current.setEnvironmentVariable({ name: 'API_TOKEN', value: 'secret-value' });

    expect(captured).toEqual({
      method: 'PUT',
      pathname: '/environment-variables/API_TOKEN',
      authorization: 'Bearer test-access-token',
      body: { value: 'secret-value' },
    });
    // A 201 means the name is new
    expect(stored).toEqual({ variable: summary('API_TOKEN'), replaced: false });
  });

  test('an existing name is replaced with a 200, and the answer says so', async () => {
    worker.use(
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(summary('API_TOKEN'), { status: 200 });
      }),
    );

    const { result } = await renderHook(() => useSetEnvironmentVariable(), { wrapper: createWrapper() });

    await expect(result.current.setEnvironmentVariable({ name: 'API_TOKEN', value: 'another-value' })).resolves.toEqual({
      variable: summary('API_TOKEN'),
      replaced: true,
    });
  });

  test('keeps the value nowhere in the query client once the request is sent, on success and on failure', async () => {
    worker.use(
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(summary('API_TOKEN'), { status: 201 });
      }),
      http.put(`${MANAGER_URL}/environment-variables/BROKEN_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    const queryClient = createQueryClient();
    const { result } = await renderHook(() => useSetEnvironmentVariable(), { wrapper: createWrapper(queryClient) });

    await result.current.setEnvironmentVariable({ name: 'API_TOKEN', value: 'secret-value-one' });
    await expect(
      result.current.setEnvironmentVariable({ name: 'BROKEN_TOKEN', value: 'secret-value-two' }),
    ).rejects.toThrow('Environment variables are not available right now');

    // No mutation is cached, so no state.variables can hold a value
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    const cached = JSON.stringify({
      mutations: queryClient.getMutationCache().getAll().map((mutation) => mutation.state),
      queries: queryClient.getQueryCache().getAll().map((query) => query.state),
    });
    expect(cached).not.toContain('secret-value-one');
    expect(cached).not.toContain('secret-value-two');
  });

  test('reports pending, success and error as its status, and reset goes back to idle', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        await gate;
        return HttpResponse.json(summary('API_TOKEN'), { status: 201 });
      }),
      http.put(`${MANAGER_URL}/environment-variables/BROKEN_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    const { result } = await renderHook(() => useSetEnvironmentVariable(), { wrapper: createWrapper() });
    expect(result.current.status).toBe('idle');

    const pending = result.current.setEnvironmentVariable({ name: 'API_TOKEN', value: 'secret-value' });
    await vi.waitFor(() => {
      expect(result.current.status).toBe('pending');
    });
    release();
    await pending;
    await vi.waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    await expect(
      result.current.setEnvironmentVariable({ name: 'BROKEN_TOKEN', value: 'secret-value' }),
    ).rejects.toThrow('Environment variables are not available right now');
    await vi.waitFor(() => {
      expect(result.current.status).toBe('error');
    });
    expect(result.current.error?.message).toBe('Environment variables are not available right now');

    result.current.reset();
    await vi.waitFor(() => {
      expect(result.current.status).toBe('idle');
    });
    expect(result.current.error).toBeUndefined();
  });

  test('reloads the list after it is set', async () => {
    let listCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        listCount += 1;
        return HttpResponse.json({ data: [summary('API_TOKEN')] });
      }),
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(summary('API_TOKEN'), { status: 201 });
      }),
    );

    const { result } = await renderHook(
      () => ({ list: useListEnvironmentVariables(), set: useSetEnvironmentVariable() }),
      { wrapper: createWrapper() },
    );

    await vi.waitFor(() => {
      expect(listCount).toBe(1);
    });

    await result.current.set.setEnvironmentVariable({ name: 'API_TOKEN', value: 'secret-value' });

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
    });
  });

  test('a 409 throws the error_description of the limit', async () => {
    worker.use(
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'limit_exceeded', error_description: 'At most 100 environment variables are allowed' },
          { status: 409 },
        );
      }),
    );

    const { result } = await renderHook(() => useSetEnvironmentVariable(), { wrapper: createWrapper() });

    await expect(result.current.setEnvironmentVariable({ name: 'API_TOKEN', value: 'secret-value' })).rejects.toThrow(
      'At most 100 environment variables are allowed',
    );
  });

  test('a 503 throws the error_description of the storage', async () => {
    worker.use(
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    const { result } = await renderHook(() => useSetEnvironmentVariable(), { wrapper: createWrapper() });

    await expect(result.current.setEnvironmentVariable({ name: 'API_TOKEN', value: 'secret-value' })).rejects.toThrow(
      'Environment variables are not available right now',
    );
  });
});

describe('useDeleteEnvironmentVariable', () => {
  test('deletes a variable with DELETE /environment-variables/:name', async () => {
    let captured: { method: string; pathname: string; authorization: string | null } | undefined;
    worker.use(
      http.delete(`${MANAGER_URL}/environment-variables/API_TOKEN`, async ({ request }) => {
        captured = {
          method: request.method,
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get('Authorization'),
        };
        return HttpResponse.json({ deleted: true });
      }),
    );

    const { result } = await renderHook(() => useDeleteEnvironmentVariable(), { wrapper: createWrapper() });

    await result.current.deleteEnvironmentVariable('API_TOKEN');

    expect(captured).toEqual({
      method: 'DELETE',
      pathname: '/environment-variables/API_TOKEN',
      authorization: 'Bearer test-access-token',
    });
  });

  test('reloads the list after it is deleted', async () => {
    let listCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        listCount += 1;
        return HttpResponse.json({ data: [summary('API_TOKEN')] });
      }),
      http.delete(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json({ deleted: true });
      }),
    );

    const { result } = await renderHook(
      () => ({ list: useListEnvironmentVariables(), remove: useDeleteEnvironmentVariable() }),
      { wrapper: createWrapper() },
    );

    await vi.waitFor(() => {
      expect(listCount).toBe(1);
    });

    await result.current.remove.deleteEnvironmentVariable('API_TOKEN');

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
    });
  });

  test('a variable that is already gone throws a 404 and still reloads the list', async () => {
    let listCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        listCount += 1;
        return HttpResponse.json({ data: [] });
      }),
      http.delete(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'not_found', error_description: 'Environment variable not found' },
          { status: 404 },
        );
      }),
    );

    const { result } = await renderHook(
      () => ({ list: useListEnvironmentVariables(), remove: useDeleteEnvironmentVariable() }),
      { wrapper: createWrapper() },
    );

    await vi.waitFor(() => {
      expect(listCount).toBe(1);
    });

    await expect(result.current.remove.deleteEnvironmentVariable('API_TOKEN')).rejects.toThrow(
      'Environment variable not found',
    );

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
    });
  });
});
