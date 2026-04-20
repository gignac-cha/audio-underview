import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { CrawlerDetailPage } from './CrawlerDetailPage.tsx';
import { ToastProvider } from '../contexts/ToastContext.tsx';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { worker } from '../tests/mocks/browser.ts';
import { page } from '@vitest/browser/context';
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

function createAuth(): AuthenticationContextValue {
  return {
    user: { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' },
    isAuthenticated: true,
    isLoading: false,
    enabledProviders: [],
    isGoogleConfigured: false,
    isGitHubConfigured: false,
    loginWithGoogle: vi.fn(),
    loginWithGitHub: vi.fn(),
    loginWithProvider: vi.fn().mockReturnValue({ success: true }),
    logout: vi.fn(),
  };
}

function renderPage(initialPath: string, children?: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <AuthenticationContext.Provider value={createAuth()}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
              <Route path="/crawlers/:id" element={<CrawlerDetailPage />} />
              <Route path="/crawlers" element={<p>Crawlers List</p>} />
            </Routes>
            {children}
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthenticationContext.Provider>,
  );
}

const mockCrawler = {
  id: 'c1',
  user_uuid: 'u1',
  name: 'Detail Crawler',
  type: 'web',
  url_pattern: '^https://example\\.com',
  code: '(body) => body.length',
  input_schema: { body: 'string' },
  output_schema: { count: 'number' },
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
};

describe('CrawlerDetailPage', () => {
  test('renders crawler details after loading', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByLabelText('Crawler name')).toHaveValue('Detail Crawler');
    await expect.element(page.getByText('web', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('URL pattern')).toHaveValue('^https://example\\.com');
  });

  test('Save button is disabled until form is dirty', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByLabelText('Crawler name')).toHaveValue('Detail Crawler');
    await expect.element(page.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  test('submits full body on save after name change', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
      http.put(`${MANAGER_URL}/crawlers/c1`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockCrawler, name: 'Renamed' });
      }),
    );

    await renderPage('/crawlers/c1');

    const nameInput = page.getByLabelText('Crawler name');
    await expect.element(nameInput).toBeVisible();
    await nameInput.fill('Renamed');

    const saveButton = page.getByRole('button', { name: /Save/ });
    await expect.element(saveButton).toBeEnabled();
    await saveButton.click();

    await vi.waitFor(() => {
      expect(capturedBody).toBeDefined();
    });

    expect(capturedBody?.name).toBe('Renamed');
    expect(capturedBody?.type).toBe('web');
    expect(capturedBody?.url_pattern).toBe('^https://example\\.com');
    expect(capturedBody).toMatchObject({ output_schema: { count: 'number' } });
    expect(capturedBody && 'id' in capturedBody).toBe(false);
  });

  test('shows error state and retry when GET fails', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(
          { error: 'not_found', error_description: 'Crawler not found' },
          { status: 404 },
        );
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByText('Failed to load crawler.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Retry/ })).toBeVisible();
  });

  test('renders data crawler without URL pattern field', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json({
          ...mockCrawler,
          type: 'data',
          url_pattern: null,
          input_schema: { userIds: 'string[]' },
        });
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByText('data', { exact: true })).toBeVisible();
    expect(page.getByLabelText('URL pattern').query()).toBeNull();
    const inputSchema = page.getByLabelText('Input schema');
    await expect.element(inputSchema).toBeVisible();
    await expect.element(inputSchema).not.toHaveAttribute('readonly');
  });

  test('Save stays disabled when name is cleared', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    const nameInput = page.getByLabelText('Crawler name');
    await expect.element(nameInput).toBeVisible();
    await nameInput.fill('');

    await expect.element(page.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  test('Revert restores pristine values and disables Save', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    const nameInput = page.getByLabelText('Crawler name');
    await expect.element(nameInput).toHaveValue('Detail Crawler');
    await nameInput.fill('Renamed Draft');
    await expect.element(page.getByRole('button', { name: /Save/ })).toBeEnabled();

    await page.getByRole('button', { name: /Revert/ }).click();

    await expect.element(nameInput).toHaveValue('Detail Crawler');
    await expect.element(page.getByRole('button', { name: /Save/ })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: /Revert/ })).toBeDisabled();
  });

  test('shows error toast when PUT fails', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
      http.put(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(
          { error: 'server_error', error_description: 'Internal error' },
          { status: 500 },
        );
      }),
    );

    await renderPage('/crawlers/c1');

    const nameInput = page.getByLabelText('Crawler name');
    await expect.element(nameInput).toBeVisible();
    await nameInput.fill('Renamed');

    await page.getByRole('button', { name: /Save/ }).click();

    await expect.element(page.getByText('Internal error')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Save/ })).toBeEnabled();
    await expect.element(nameInput).toHaveValue('Renamed');
  });

  test('shows inline error and disables save on invalid JSON schema', async () => {
    let putCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
      http.put(`${MANAGER_URL}/crawlers/c1`, async () => {
        putCount += 1;
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    const outputSchema = page.getByLabelText('Output schema');
    await expect.element(outputSchema).toBeVisible();
    await outputSchema.fill('{ not json');

    const saveButton = page.getByRole('button', { name: /Save/ });
    await saveButton.click();

    await expect.element(page.getByText('Must be a valid JSON object.')).toBeVisible();
    await expect.element(saveButton).toBeDisabled();
    expect(putCount).toBe(0);

    await outputSchema.fill('{"count":"number"}');

    // onChange clears the inline error immediately when value becomes valid — no blur required.
    await expect.element(page.getByText('Must be a valid JSON object.')).not.toBeInTheDocument();
    await expect.element(saveButton).toBeEnabled();
    await saveButton.click();

    await vi.waitFor(() => {
      expect(putCount).toBe(1);
    });
  });
});
