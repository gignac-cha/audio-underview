import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CrawlerEditorPage } from '../sources/pages/CrawlerEditorPage.tsx';
import { testCrawler, testSession } from './fixtures.ts';
import { server, workerURLs } from './mocks/server.ts';
import { renderApp } from './test-utils.tsx';

const routes = [
  { path: '/crawlers/:id', element: <CrawlerEditorPage /> },
  { path: '/crawlers', element: <div>Crawlers list</div> },
];

const renderDetail = (id: string) =>
  renderApp({ routes, initialEntries: [`/crawlers/${id}`], session: testSession() });

describe('CrawlerEditorPage', () => {
  it('opens an existing crawler in read-only view mode', async () => {
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, () =>
        HttpResponse.json(testCrawler({ name: 'View me' })),
      ),
    );

    renderDetail(testCrawler().id);

    expect(await screen.findByRole('heading', { name: 'View me' })).toBeInTheDocument();
    expect(screen.getByText('View')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
    const editor = screen.getByTestId('code-editor') as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
  });

  it('marks the form dirty and saves an edit, returning to view mode', async () => {
    let updateBody: Record<string, unknown> | undefined;
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, () =>
        HttpResponse.json(testCrawler({ name: 'Original' })),
      ),
      http.put(`${workerURLs.crawlerManager}/crawlers/:id`, async ({ request }) => {
        updateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(testCrawler({ name: 'Renamed' }));
      }),
    );

    const { user } = renderDetail(testCrawler().id);

    await screen.findByRole('heading', { name: 'Original' });
    await user.click(screen.getByRole('button', { name: /Edit/ }));

    const nameInput = screen.getByLabelText('Name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed');

    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => {
      expect(updateBody).toMatchObject({ type: 'web', name: 'Renamed' });
    });
    expect(updateBody).not.toHaveProperty('id');
    // 저장 후 view 모드 복귀
    expect(await screen.findByText('View')).toBeInTheDocument();
  });

  it('soft-disables Save with a reason when the name is empty', async () => {
    server.use(
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, () =>
        HttpResponse.json(testCrawler({ name: 'Original' })),
      ),
    );

    const { user } = renderDetail(testCrawler().id);

    await screen.findByRole('heading', { name: 'Original' });
    await user.click(screen.getByRole('button', { name: /Edit/ }));
    await user.clear(screen.getByLabelText('Name'));

    const saveButton = screen.getByRole('button', { name: /Save/ });
    expect(saveButton).toHaveAttribute('aria-disabled', 'true');
    expect(saveButton).toHaveAttribute('title', 'Name is required.');
  });

  it('creates a new crawler and navigates to its detail view', async () => {
    server.use(
      http.post(`${workerURLs.crawlerManager}/crawlers`, () =>
        HttpResponse.json(testCrawler({ name: 'Fresh' })),
      ),
      http.get(`${workerURLs.crawlerManager}/crawlers/:id`, () =>
        HttpResponse.json(testCrawler({ name: 'Fresh' })),
      ),
    );

    const { user } = renderApp({
      routes,
      initialEntries: ['/crawlers/new'],
      session: testSession(),
    });

    expect(await screen.findByText('New Crawler')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Fresh');
    await user.type(screen.getByLabelText('URL pattern'), '^https://x');
    await user.type(screen.getByTestId('code-editor'), '() => 1');

    await user.click(screen.getByRole('button', { name: /Submit/ }));

    // 생성 후 상세 라우트로 이동 → view 모드로 로드
    expect(await screen.findByRole('heading', { name: 'Fresh' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Edit/ })).toBeInTheDocument();
  });
});
