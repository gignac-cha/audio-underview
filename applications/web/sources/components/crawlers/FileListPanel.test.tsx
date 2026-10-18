import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { FileListPanel } from './FileListPanel.tsx';
import type { CrawlerFileReference } from './crawler-file-references.ts';

const MANAGER_URL = 'http://localhost:8888';
const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

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

function renderPanel(files: CrawlerFileReference[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FileListPanel files={files} />
    </QueryClientProvider>,
  );
}

const files: CrawlerFileReference[] = [
  { file_id: FIRST_ID, content_type: 'text/csv', size: 512, name: 'report.csv' },
  { file_id: SECOND_ID, content_type: 'image/png', size: 3 * 1024 * 1024, name: null },
];

describe('FileListPanel', () => {
  test('lists the name, type and size of each file, and the id of a file without a name', async () => {
    await renderPanel(files);

    await expect.element(page.getByText('Files', { exact: true })).toBeVisible();
    await expect.element(page.getByText('report.csv')).toBeVisible();
    await expect.element(page.getByText('text/csv · 512 B')).toBeVisible();
    await expect.element(page.getByText(SECOND_ID)).toBeVisible();
    await expect.element(page.getByText('image/png · 3.0 MB')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Download report.csv' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: `Download ${SECOND_ID}` })).toBeVisible();
  });

  test('shows a size in kibibytes between 1 KB and 1 MB', async () => {
    await renderPanel([{ file_id: FIRST_ID, content_type: 'text/plain', size: 1536, name: 'notes.txt' }]);

    await expect.element(page.getByText('text/plain · 1.5 KB')).toBeVisible();
  });

  test('Download requests GET /files/:id with the token and saves a blob under the name of the file', async () => {
    let captured: { pathname: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/files/${FIRST_ID}`, async ({ request }) => {
        captured = { pathname: new URL(request.url).pathname, authorization: request.headers.get('Authorization') };
        return new HttpResponse('a,b\n1,2\n', { headers: { 'Content-Type': 'text/csv' } });
      }),
    );
    const savedFiles: { fileName: string; content: Promise<string> }[] = [];
    let pendingContent: Promise<string> = Promise.resolve('');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
      pendingContent = (object as Blob).text();
      return 'blob:test';
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      savedFiles.push({ fileName: this.download, content: pendingContent });
    });

    try {
      await renderPanel(files);

      await page.getByRole('button', { name: 'Download report.csv' }).click();

      await vi.waitFor(() => {
        expect(savedFiles).toHaveLength(1);
      });
      expect(captured).toEqual({ pathname: `/files/${FIRST_ID}`, authorization: 'Bearer test-access-token' });
      expect(savedFiles[0].fileName).toBe('report.csv');
      expect(await savedFiles[0].content).toBe('a,b\n1,2\n');
    } finally {
      createObjectURL.mockRestore();
      click.mockRestore();
    }
  });

  test('says that the file was not found or expired on a 404, on that row only', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/files/${FIRST_ID}`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'File not found' }, { status: 404 });
      }),
    );

    await renderPanel(files);

    await page.getByRole('button', { name: 'Download report.csv' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('File not found or expired');
    expect(page.getByRole('alert').elements()).toHaveLength(1);
  });
});
