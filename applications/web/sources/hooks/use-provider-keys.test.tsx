import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { useDeleteProviderKey, useProviderKeyAudit, useProviderKeys, useSetProviderKey } from './use-provider-keys.ts';
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

const ANTHROPIC_KEY = 'sk-ant-api03-test-key-0001';
const OPENAI_KEY = 'sk-proj-test-key-0002-abcd';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient = createQueryClient()) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function unconfiguredList() {
  return {
    data: ['anthropic', 'openai', 'google', 'xai'].map((provider) => ({ provider, configured: false, last4: null, validated_at: null })),
  };
}

function configured(provider: string, last4: string) {
  return { provider, configured: true, last4, validated_at: '2026-10-26T00:00:00.000Z' };
}

describe('useProviderKeys', () => {
  test('lists the four providers with GET /provider-keys', async () => {
    let captured: { method: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async ({ request }) => {
        captured = { method: request.method, authorization: request.headers.get('Authorization') };
        return HttpResponse.json(unconfiguredList());
      }),
    );

    const { result } = await renderHook(() => useProviderKeys(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.providerKeys).toHaveLength(4);
    });
    expect(captured).toEqual({ method: 'GET', authorization: 'Bearer test-access-token' });
    expect(result.current.providerKeys.map(({ provider }) => provider)).toEqual(['anthropic', 'openai', 'google', 'xai']);
    expect(result.current.isLoaded).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  test('exposes the error_description of a 503', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => {
        return HttpResponse.json({ error: 'service_unavailable', error_description: 'Provider keys are not available right now' }, { status: 503 });
      }),
    );

    const { result } = await renderHook(() => useProviderKeys(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('Provider keys are not available right now');
    });
    expect(result.current.isLoaded).toBe(false);
  });

  test('rejects an answer of another shape', async () => {
    worker.use(http.get(`${MANAGER_URL}/provider-keys`, async () => HttpResponse.json({ keys: [] })));

    const { result } = await renderHook(() => useProviderKeys(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('The server sent a response this page cannot read.');
    });
  });
});

describe('useProviderKeyAudit', () => {
  test('lists the history with GET /provider-keys/audit in the order of the server', async () => {
    let authorization: string | null = null;
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys/audit`, async ({ request }) => {
        authorization = request.headers.get('Authorization');
        return HttpResponse.json({
          data: [
            { provider: 'google', action: 'used', at: '2026-10-26T02:00:00.000Z' },
            { provider: 'google', action: 'registered', at: '2026-10-26T01:00:00.000Z' },
          ],
        });
      }),
    );

    const { result } = await renderHook(() => useProviderKeyAudit(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.events).toHaveLength(2);
    });
    expect(authorization).toBe('Bearer test-access-token');
    expect(result.current.events.map(({ action }) => action)).toEqual(['used', 'registered']);
  });

  test('rejects an action it does not know', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => {
        return HttpResponse.json({ data: [{ provider: 'google', action: 'viewed', at: '2026-10-26T00:00:00.000Z' }] });
      }),
    );

    const { result } = await renderHook(() => useProviderKeyAudit(), { wrapper: createWrapper() });

    await vi.waitFor(() => {
      expect(result.current.error?.message).toBe('The server sent a response this page cannot read.');
    });
  });
});

describe('useSetProviderKey', () => {
  test('registers a key with PUT /provider-keys/:provider and the key', async () => {
    let captured: { method: string; pathname: string; authorization: string | null; body: unknown } | undefined;
    worker.use(
      http.put(`${MANAGER_URL}/provider-keys/anthropic`, async ({ request }) => {
        captured = {
          method: request.method,
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get('Authorization'),
          body: await request.json(),
        };
        return HttpResponse.json(configured('anthropic', '0001'));
      }),
    );

    const { result } = await renderHook(() => useSetProviderKey(), { wrapper: createWrapper() });

    const stored = await result.current.setProviderKey({ provider: 'anthropic', key: ANTHROPIC_KEY });

    expect(captured).toEqual({
      method: 'PUT',
      pathname: '/provider-keys/anthropic',
      authorization: 'Bearer test-access-token',
      body: { key: ANTHROPIC_KEY },
    });
    expect(stored).toEqual(configured('anthropic', '0001'));
  });

  test.each([
    [400, 'invalid_key', 'The provider did not accept this key'],
    [503, 'validation_unavailable', 'The provider could not be reached to check the key. Try again later'],
    [503, 'service_unavailable', 'Provider keys are not available right now'],
  ])('a %i %s throws its error_description', async (status, error, description) => {
    worker.use(
      http.put(`${MANAGER_URL}/provider-keys/openai`, async () => {
        return HttpResponse.json({ error, error_description: description }, { status });
      }),
    );

    const { result } = await renderHook(() => useSetProviderKey(), { wrapper: createWrapper() });

    await expect(result.current.setProviderKey({ provider: 'openai', key: OPENAI_KEY })).rejects.toThrow(description);
  });

  test('keeps the key nowhere in the query client once the request is sent, on success and on failure', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => HttpResponse.json(unconfiguredList())),
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => HttpResponse.json({ data: [] })),
      http.put(`${MANAGER_URL}/provider-keys/anthropic`, async () => HttpResponse.json(configured('anthropic', '0001'))),
      http.put(`${MANAGER_URL}/provider-keys/openai`, async () => {
        return HttpResponse.json({ error: 'invalid_key', error_description: 'The provider did not accept this key' }, { status: 400 });
      }),
    );

    const queryClient = createQueryClient();
    const { result } = await renderHook(() => ({ list: useProviderKeys(), set: useSetProviderKey() }), {
      wrapper: createWrapper(queryClient),
    });

    await result.current.set.setProviderKey({ provider: 'anthropic', key: ANTHROPIC_KEY });
    await expect(result.current.set.setProviderKey({ provider: 'openai', key: OPENAI_KEY })).rejects.toThrow('The provider did not accept this key');

    // No mutation is cached, so no state.variables can hold a key
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    const cached = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.state),
    );
    expect(cached).not.toContain(ANTHROPIC_KEY);
    expect(cached).not.toContain(OPENAI_KEY);
  });

  test('names the provider as pending until its answer arrives', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.put(`${MANAGER_URL}/provider-keys/google`, async () => {
        await gate;
        return HttpResponse.json(configured('google', 'wxyz'));
      }),
    );

    const { result } = await renderHook(() => useSetProviderKey(), { wrapper: createWrapper() });
    expect(result.current.pendingProviders).toEqual([]);

    const pending = result.current.setProviderKey({ provider: 'google', key: 'AIzaSyTest-google-key-wxyz' });
    await vi.waitFor(() => {
      expect(result.current.pendingProviders).toEqual(['google']);
    });

    release();
    await pending;
    await vi.waitFor(() => {
      expect(result.current.pendingProviders).toEqual([]);
    });
  });

  test('reloads the list and the history after a key is registered', async () => {
    let listCount = 0;
    let auditCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => {
        listCount += 1;
        return HttpResponse.json(unconfiguredList());
      }),
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => {
        auditCount += 1;
        return HttpResponse.json({ data: [] });
      }),
      http.put(`${MANAGER_URL}/provider-keys/anthropic`, async () => HttpResponse.json(configured('anthropic', '0001'))),
    );

    const { result } = await renderHook(() => ({ list: useProviderKeys(), audit: useProviderKeyAudit(), set: useSetProviderKey() }), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(listCount).toBe(1);
      expect(auditCount).toBe(1);
    });

    await result.current.set.setProviderKey({ provider: 'anthropic', key: ANTHROPIC_KEY });

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
      expect(auditCount).toBe(2);
    });
  });
});

describe('useDeleteProviderKey', () => {
  test('removes a key with DELETE /provider-keys/:provider', async () => {
    let captured: { method: string; pathname: string; authorization: string | null } | undefined;
    worker.use(
      http.delete(`${MANAGER_URL}/provider-keys/xai`, async ({ request }) => {
        captured = {
          method: request.method,
          pathname: new URL(request.url).pathname,
          authorization: request.headers.get('Authorization'),
        };
        return HttpResponse.json({ deleted: true });
      }),
    );

    const { result } = await renderHook(() => useDeleteProviderKey(), { wrapper: createWrapper() });

    await result.current.deleteProviderKey('xai');

    expect(captured).toEqual({ method: 'DELETE', pathname: '/provider-keys/xai', authorization: 'Bearer test-access-token' });
  });

  test('a key that is already gone throws a 404 and still reloads the list and the history', async () => {
    let listCount = 0;
    let auditCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => {
        listCount += 1;
        return HttpResponse.json(unconfiguredList());
      }),
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => {
        auditCount += 1;
        return HttpResponse.json({ data: [] });
      }),
      http.delete(`${MANAGER_URL}/provider-keys/openai`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Provider key not found' }, { status: 404 });
      }),
    );

    const { result } = await renderHook(() => ({ list: useProviderKeys(), audit: useProviderKeyAudit(), remove: useDeleteProviderKey() }), {
      wrapper: createWrapper(),
    });

    await vi.waitFor(() => {
      expect(listCount).toBe(1);
      expect(auditCount).toBe(1);
    });

    await expect(result.current.remove.deleteProviderKey('openai')).rejects.toThrow('Provider key not found');

    await vi.waitFor(() => {
      expect(listCount).toBe(2);
      expect(auditCount).toBe(2);
    });
  });
});
