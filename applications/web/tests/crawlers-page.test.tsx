import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CrawlersPage } from '../sources/pages/CrawlersPage.tsx';
import { listEnvelope, testCrawler, testSession } from './fixtures.ts';
import { server, workerURLs } from './mocks/server.ts';
import { renderApp } from './test-utils.tsx';

const routes = [
  { path: '/crawlers', element: <CrawlersPage /> },
  { path: '/crawlers/new', element: <div>New crawler route</div> },
  { path: '/crawlers/:id', element: <div>Crawler detail route</div> },
];

const render = () =>
  renderApp({ routes, initialEntries: ['/crawlers'], session: testSession() });

describe('CrawlersPage', () => {
  it('shows the empty state with a create call to action', async () => {
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers`, () =>
        HttpResponse.json(listEnvelope([])),
      ),
    );

    render();

    expect(await screen.findByText('No crawlers yet.')).toBeInTheDocument();
  });

  it('renders a card per crawler', async () => {
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers`, () =>
        HttpResponse.json(listEnvelope([testCrawler({ name: 'Alpha crawler' })])),
      ),
    );

    render();

    expect(await screen.findByText('Alpha crawler')).toBeInTheDocument();
  });

  it('shows an error state with Retry on failure', async () => {
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers`, () =>
        HttpResponse.json({ error: 'server_error' }, { status: 500 }),
      ),
    );

    render();

    expect(await screen.findByText('Failed to load crawlers.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('deletes a crawler after confirmation', async () => {
    let deleted = false;
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers`, () =>
        HttpResponse.json(listEnvelope(deleted ? [] : [testCrawler({ name: 'Doomed' })])),
      ),
      http.delete(`${workerURLs.crawlerManager}/crawlers/:id`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { user } = render();

    await screen.findByText('Doomed');
    await user.click(screen.getByRole('button', { name: /Delete Doomed/i }));
    // 확인 다이얼로그
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleted).toBe(true);
    });
  });
});
