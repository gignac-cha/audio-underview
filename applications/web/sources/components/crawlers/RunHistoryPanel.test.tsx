import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { RunHistoryPanel } from './RunHistoryPanel.tsx';

const MANAGER_URL = 'http://localhost:8888';
const CRAWLER_ID = '11111111-1111-4111-8111-111111111111';

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

function renderPanel(crawlerID: string | null, onSelect = vi.fn(), selectedRunID?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunHistoryPanel crawlerID={crawlerID} selectedRunID={selectedRunID} onSelect={onSelect} />
    </QueryClientProvider>,
  );
}

function summary(index: number, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe('RunHistoryPanel', () => {
  test('shows the kind, status, start time and duration of each run', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({
          data: [
            summary(1, { kind: 'test', completed_at: '2024-01-01T00:01:05.000Z' }),
            summary(2, { kind: 'direct', completed_at: '2024-01-01T00:00:00.450Z' }),
          ],
          total: 2,
          offset: 0,
          limit: 20,
        });
      }),
    );

    await renderPanel(CRAWLER_ID);

    await expect.element(page.getByText('Test', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Direct', { exact: true })).toBeVisible();
    await expect.element(page.getByText('1m 5s')).toBeVisible();
    await expect.element(page.getByText('450ms')).toBeVisible();
    expect(page.getByText('Completed').elements()).toHaveLength(2);
  });

  test('shows the error code of a failed run', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({
          data: [summary(1, { status: 'failed', error_code: 'execution_failed' })],
          total: 1,
          offset: 0,
          limit: 20,
        });
      }),
    );

    await renderPanel(CRAWLER_ID);

    await expect.element(page.getByText('Failed', { exact: true })).toBeVisible();
    await expect.element(page.getByText('execution_failed')).toBeVisible();
  });

  test('lists the test runs of crawlers that are not saved when the crawler id is null', async () => {
    let requestedPathname = '';
    worker.use(
      http.get(`${MANAGER_URL}/crawler-test-runs`, async ({ request }) => {
        requestedPathname = new URL(request.url).pathname;
        return HttpResponse.json({
          data: [summary(1, { crawler_id: null, kind: 'test' })],
          total: 1,
          offset: 0,
          limit: 20,
        });
      }),
    );

    await renderPanel(null);

    await expect.element(page.getByText('Test', { exact: true })).toBeVisible();
    expect(requestedPathname).toBe('/crawler-test-runs');
  });

  test('says that there are no runs yet', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({ data: [], total: 0, offset: 0, limit: 20 });
      }),
    );

    await renderPanel(CRAWLER_ID);

    await expect.element(page.getByText('No runs yet.')).toBeVisible();
  });

  test('calls onSelect with the id of the run that is clicked and marks the selected one', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        return HttpResponse.json({ data: [summary(1), summary(2, { kind: 'test' })], total: 2, offset: 0, limit: 20 });
      }),
    );
    const onSelect = vi.fn();

    await renderPanel(CRAWLER_ID, onSelect, summary(2).id);

    await page.getByRole('button', { name: /Direct/ }).click();

    expect(onSelect).toHaveBeenCalledWith(summary(1).id);
    await expect.element(page.getByRole('button', { name: /Test/ })).toHaveAttribute('aria-current', 'true');
    await expect.element(page.getByRole('button', { name: /Direct/ })).not.toHaveAttribute('aria-current');
  });

  test('loads the next twenty with Load More until the end', async () => {
    const offsets: number[] = [];
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get('offset'));
        offsets.push(offset);
        const data = Array.from({ length: offset === 0 ? 20 : 5 }, (_, index) => summary(offset + index + 1));
        return HttpResponse.json({ data, total: 25, offset, limit: 20 });
      }),
    );

    await renderPanel(CRAWLER_ID);

    await expect.element(page.getByRole('button', { name: 'Load More' })).toBeVisible();
    expect(page.getByRole('button', { name: /Direct/ }).elements()).toHaveLength(20);

    await page.getByRole('button', { name: 'Load More' }).click();

    await vi.waitFor(() => {
      expect(page.getByRole('button', { name: /Direct/ }).elements()).toHaveLength(25);
    });
    expect(offsets).toEqual([0, 20]);
    expect(page.getByRole('button', { name: 'Load More' }).query()).toBeNull();
  });

  test('shows the error of the request and retries it', async () => {
    let requests = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/${CRAWLER_ID}/runs`, async () => {
        requests += 1;
        if (requests === 1) {
          return HttpResponse.json({ error: 'server_error', error_description: 'Database is down' }, { status: 500 });
        }
        return HttpResponse.json({ data: [summary(1)], total: 1, offset: 0, limit: 20 });
      }),
    );

    await renderPanel(CRAWLER_ID);

    await expect.element(page.getByRole('alert')).toHaveTextContent('Failed to load run history: Database is down');

    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.element(page.getByText('Direct', { exact: true })).toBeVisible();
    expect(requests).toBe(2);
  });
});
