import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { CrawlerEditorPage } from './CrawlerEditorPage.tsx';
import { ToastProvider } from '../contexts/ToastContext.tsx';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { worker } from '../tests/mocks/browser.ts';
import { page } from '@vitest/browser/context';
import type { ReactNode } from 'react';

const MANAGER_URL = 'http://localhost:8888';
const TEST_PANEL_STORAGE_KEY = 'crawler-editor:test-panel-open';

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
              <Route path="/crawlers/:id" element={<CrawlerEditorPage />} />
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

describe('CrawlerEditorPage — view/edit flows', () => {
  test('renders crawler details read-only by default with test panel hidden', async () => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);

    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByRole('heading', { name: 'Detail Crawler' })).toBeVisible();
    await expect.element(page.getByText('web', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('URL pattern')).toHaveTextContent('^https://example\\.com');
    await expect.element(page.getByText('View', { exact: true })).toBeVisible();

    await expect.element(page.getByRole('button', { name: /Edit crawler/ })).toBeVisible();
    expect(page.getByRole('button', { name: /Save/ }).query()).toBeNull();
    expect(page.getByRole('button', { name: /Cancel/ }).query()).toBeNull();

    expect(page.getByRole('heading', { name: 'Test Runner' }).query()).toBeNull();
    await expect.element(page.getByRole('button', { name: /Show test panel/ })).toBeVisible();
  });

  test('View mode test-panel toggle shows the panel and persists state', async () => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);

    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Show test panel/ }).click();

    await expect.element(page.getByRole('heading', { name: 'Test Runner' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Hide test panel/ })).toBeVisible();
    expect(window.localStorage.getItem(TEST_PANEL_STORAGE_KEY)).toBe('open');
  });

  test('Edit button swaps to editable form and forces test panel on', async () => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);

    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Edit crawler/ }).click();

    await expect.element(page.getByLabelText('Crawler name')).toHaveValue('Detail Crawler');
    await expect.element(page.getByLabelText('URL pattern')).toHaveValue('^https://example\\.com');
    await expect.element(page.getByText('Edit', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Save/ })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Cancel/ })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Test Runner' })).toBeVisible();
    expect(page.getByRole('button', { name: /Show test panel/ }).query()).toBeNull();
    expect(page.getByRole('button', { name: /Hide test panel/ }).query()).toBeNull();
  });

  test('Save button is disabled until form is dirty', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Edit crawler/ }).click();

    await expect.element(page.getByLabelText('Crawler name')).toHaveValue('Detail Crawler');
    await expect.element(page.getByRole('button', { name: /Save/ })).toHaveAttribute('aria-disabled', 'true');
  });

  test('submits full body on save and returns to view mode', async () => {
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

    await page.getByRole('button', { name: /Edit crawler/ }).click();

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

    await expect.element(page.getByRole('heading', { name: 'Renamed' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Edit crawler/ })).toBeVisible();
    expect(page.getByRole('button', { name: /Save/ }).query()).toBeNull();
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

  test('renders data crawler without URL pattern field and allows input schema edit', async () => {
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

    await page.getByRole('button', { name: /Edit crawler/ }).click();

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

    await page.getByRole('button', { name: /Edit crawler/ }).click();

    const nameInput = page.getByLabelText('Crawler name');
    await expect.element(nameInput).toBeVisible();
    await nameInput.fill('');

    await expect.element(page.getByRole('button', { name: /Save/ })).toHaveAttribute('aria-disabled', 'true');
  });

  test('Cancel restores pristine values and exits edit mode after confirm', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Edit crawler/ }).click();

    const nameInput = page.getByLabelText('Crawler name');
    await expect.element(nameInput).toHaveValue('Detail Crawler');
    await nameInput.fill('Renamed Draft');
    await expect.element(page.getByText('Unsaved')).toBeVisible();

    await page.getByRole('button', { name: /Cancel/ }).click();

    await expect.element(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();

    await expect.element(page.getByRole('heading', { name: 'Detail Crawler' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /Edit crawler/ })).toBeVisible();
    expect(page.getByRole('button', { name: /Save/ }).query()).toBeNull();
  });

  test('Cancel on clean edit mode exits without opening discard dialog', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Edit crawler/ }).click();
    await page.getByRole('button', { name: /Cancel/ }).click();

    expect(page.getByRole('alertdialog').query()).toBeNull();
    await expect.element(page.getByRole('button', { name: /Edit crawler/ })).toBeVisible();
  });

  test('Cancel stays in edit mode when user keeps editing', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Edit crawler/ }).click();
    const nameInput = page.getByLabelText('Crawler name');
    await nameInput.fill('Still editing');

    await page.getByRole('button', { name: /Cancel/ }).click();

    await expect.element(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();

    await expect.element(nameInput).toHaveValue('Still editing');
    await expect.element(page.getByRole('button', { name: /Save/ })).toBeVisible();
  });

  test('Unsaved indicator toggles with dirty state', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByRole('button', { name: /Edit crawler/ }).click();
    expect(page.getByText('Unsaved').query()).toBeNull();

    const nameInput = page.getByLabelText('Crawler name');
    await nameInput.fill('Drafted');
    await expect.element(page.getByText('Unsaved')).toBeVisible();

    await nameInput.fill('Detail Crawler');
    expect(page.getByText('Unsaved').query()).toBeNull();
  });

  test('shows error toast when PUT fails and stays in edit mode', async () => {
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

    await page.getByRole('button', { name: /Edit crawler/ }).click();

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

    await page.getByRole('button', { name: /Edit crawler/ }).click();

    const outputSchema = page.getByLabelText('Output schema');
    await expect.element(outputSchema).toBeVisible();
    await outputSchema.fill('{ not json');

    const saveButton = page.getByRole('button', { name: /Save/ });
    await saveButton.click();

    await expect.element(page.getByText('Must be a valid JSON object.')).toBeVisible();
    await expect.element(saveButton).toHaveAttribute('aria-disabled', 'true');
    expect(putCount).toBe(0);

    await outputSchema.fill('{"count":"number"}');

    await expect.element(page.getByText('Must be a valid JSON object.')).not.toBeInTheDocument();
    await expect.element(saveButton).toBeEnabled();
    await saveButton.click();

    await vi.waitFor(() => {
      expect(putCount).toBe(1);
    });
  });
});

describe('CrawlerEditorPage — create flow', () => {
  test('renders blank form in create mode with Submit button and always-on test panel', async () => {
    await renderPage('/crawlers/new');

    await expect.element(page.getByRole('heading', { name: 'New Crawler' })).toBeVisible();
    await expect.element(page.getByText('Create', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('Crawler name')).toHaveValue('');
    await expect.element(page.getByLabelText('URL pattern')).toHaveValue('');
    await expect.element(page.getByRole('button', { name: /Submit/ })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Test Runner' })).toBeVisible();

    expect(page.getByRole('heading', { name: 'Input Schema' }).query()).toBeNull();
    expect(page.getByRole('heading', { name: 'Output Schema' }).query()).toBeNull();
  });

  test('Submit posts create payload and navigates to the new detail route', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ...mockCrawler,
          id: 'c-new',
          name: 'Freshly Created',
        });
      }),
      http.get(`${MANAGER_URL}/crawlers/c-new`, async () => {
        return HttpResponse.json({
          ...mockCrawler,
          id: 'c-new',
          name: 'Freshly Created',
        });
      }),
    );

    await renderPage('/crawlers/new');

    await page.getByLabelText('Crawler name').fill('Freshly Created');
    await page.getByLabelText('URL pattern').fill('^https://new\\.example');

    const submitButton = page.getByRole('button', { name: /Submit/ });
    await expect.element(submitButton).toBeEnabled();
    await submitButton.click();

    await vi.waitFor(() => {
      expect(capturedBody).toBeDefined();
    });

    expect(capturedBody).toMatchObject({
      name: 'Freshly Created',
      url_pattern: '^https://new\\.example',
    });

    await expect.element(page.getByRole('heading', { name: 'Freshly Created' })).toBeVisible();
  });
});
