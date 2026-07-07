import { crawlerSchema } from '@audio-underview/schemas';
import { createStore } from 'jotai';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../sources/api/client.ts';
import { ApiError } from '../sources/api/errors.ts';
import { sessionAtom } from '../sources/state/session.ts';
import { testCrawler, testSession, testUser } from './fixtures.ts';
import { server, workerURLs } from './mocks/server.ts';

const tokenResponse = {
  access_token: 'access-token-2',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'refresh-token-2',
  user: testUser,
};

const makeClient = () => {
  const store = createStore();
  const onLogout = vi.fn(() => {
    store.set(sessionAtom, null);
  });
  const client = new ApiClient(store, onLogout);
  return { store, client, onLogout };
};

describe('ApiClient', () => {
  it('injects the Bearer access token', async () => {
    const { store, client } = makeClient();
    store.set(sessionAtom, testSession());
    let seenAuthorization: string | null = null;
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, ({ request }) => {
        seenAuthorization = request.headers.get('Authorization');
        return HttpResponse.json(testCrawler());
      }),
    );

    const result = await client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers/x', {
      schema: crawlerSchema,
    });

    expect(seenAuthorization).toBe('Bearer access-token-1');
    expect(result.name).toBe('Example crawler');
  });

  it('refreshes and retries once on a 401', async () => {
    const { store, client } = makeClient();
    store.set(sessionAtom, testSession());
    let attempts = 0;
    server.use(
      http.post(`${workerURLs.authentication}/tokens`, () => HttpResponse.json(tokenResponse)),
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, ({ request }) => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
        }
        return HttpResponse.json(testCrawler({ name: 'After refresh' }), {
          headers: { 'x-auth': request.headers.get('Authorization') ?? '' },
        });
      }),
    );

    const result = await client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers/x', {
      schema: crawlerSchema,
    });

    expect(attempts).toBe(2);
    expect(result.name).toBe('After refresh');
    expect(store.get(sessionAtom)?.accessToken).toBe('access-token-2');
  });

  it('proactively refreshes an expired access token before the request', async () => {
    const { store, client } = makeClient();
    store.set(sessionAtom, testSession({ expiresAt: Date.now() - 1000 }));
    const seen: string[] = [];
    server.use(
      http.post(`${workerURLs.authentication}/tokens`, () => HttpResponse.json(tokenResponse)),
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, ({ request }) => {
        seen.push(request.headers.get('Authorization') ?? '');
        return HttpResponse.json(testCrawler());
      }),
    );

    await client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers/x', {
      schema: crawlerSchema,
    });

    expect(seen).toEqual(['Bearer access-token-2']);
  });

  it('logs out when the refresh fails', async () => {
    const { store, client, onLogout } = makeClient();
    store.set(sessionAtom, testSession());
    server.use(
      http.post(`${workerURLs.authentication}/tokens`, () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );

    await expect(
      client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers/x', { schema: crawlerSchema }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(onLogout).toHaveBeenCalled();
    expect(store.get(sessionAtom)).toBeNull();
  });

  it('derives the error message from { error, error_description }', async () => {
    const { store, client } = makeClient();
    store.set(sessionAtom, testSession());
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, () =>
        HttpResponse.json(
          { error: 'not_found', error_description: 'Crawler not found' },
          { status: 404 },
        ),
      ),
    );

    await expect(
      client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers/x', { schema: crawlerSchema }),
    ).rejects.toThrow('Crawler not found');
  });
});
