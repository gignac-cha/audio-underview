import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  useCreateCrawler,
  useListCrawlers,
  useUpdateCrawler,
} from '../sources/api/crawlers.ts';
import { listEnvelope, testCrawler, testSession } from './fixtures.ts';
import { server, workerURLs } from './mocks/server.ts';
import { createHookWrapper } from './test-utils.tsx';

describe('crawler manager hooks', () => {
  it('lists crawlers with pagination params and Authorization header', async () => {
    let seenURL: URL | undefined;
    let seenAuthorization: string | null = null;
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers`, ({ request }) => {
        seenURL = new URL(request.url);
        seenAuthorization = request.headers.get('Authorization');
        return HttpResponse.json(listEnvelope([testCrawler()]));
      }),
    );

    const { wrapper } = createHookWrapper(testSession());
    const { result } = renderHook(() => useListCrawlers(), { wrapper });

    await waitFor(() => {
      expect(result.current.crawlers).toHaveLength(1);
    });
    expect(seenURL?.searchParams.get('offset')).toBe('0');
    expect(seenURL?.searchParams.get('limit')).toBe('20');
    expect(seenAuthorization).toBe('Bearer access-token-1');
  });

  it('creates a crawler with the { name, url_pattern, code } body', async () => {
    let body: unknown;
    server.use(
      http.post(`${workerURLs.crawlerManager}/crawlers`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(testCrawler({ name: 'Created' }));
      }),
    );

    const { wrapper } = createHookWrapper(testSession());
    const { result } = renderHook(() => useCreateCrawler(), { wrapper });

    await act(async () => {
      await result.current.createCrawler({ name: 'Created', url_pattern: '^x', code: '() => 1' });
    });

    expect(body).toEqual({ name: 'Created', url_pattern: '^x', code: '() => 1' });
  });

  it('sends a typed update payload that excludes the id', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.put(`${workerURLs.crawlerManager}/crawlers/:id`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(testCrawler());
      }),
    );

    const { wrapper } = createHookWrapper(testSession());
    const { result } = renderHook(() => useUpdateCrawler(), { wrapper });

    await act(async () => {
      await result.current.updateCrawler({
        id: testCrawler().id,
        body: {
          type: 'web',
          name: 'Renamed',
          url_pattern: '^y',
          code: '() => 2',
          output_schema: {},
        },
      });
    });

    expect(body).not.toHaveProperty('id');
    expect(body).toMatchObject({ type: 'web', name: 'Renamed' });
  });
});
