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
import { page } from 'vitest/browser';
import { DEFAULT_CODE } from '../components/crawlers/CodeEditorPanel.tsx';
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
              <Route path="/settings" element={<p>Settings Page</p>} />
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

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const FILE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_FILE_ID = '44444444-4444-4444-8444-444444444444';

const dataCrawler = {
  ...mockCrawler,
  type: 'data',
  url_pattern: null,
  input_schema: { userIds: 'string[]' },
};

function completedRun(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    status: 'completed',
    result: { title: 'Hello' },
    logs: [{ level: 'info', message: 'fetched the page', timestamp: '2024-01-01T10:00:00.000' }],
    logs_truncated: false,
    ...overrides,
  };
}

function failedRun(overrides: Record<string, unknown> = {}) {
  return {
    run_id: RUN_ID,
    status: 'failed',
    error: 'execution_failed',
    error_description: 'TypeError: body is not a function',
    logs: [{ level: 'error', message: 'boom', timestamp: '2024-01-01T10:00:00.000' }],
    logs_truncated: false,
    ...overrides,
  };
}

function runSummary(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    crawler_id: 'c1',
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

function runDetail(index: number, overrides: Record<string, unknown> = {}) {
  return {
    ...runSummary(index),
    user_uuid: 'u1',
    result: { title: 'Past title' },
    error: null,
    logs: [{ level: 'info', message: 'past log line', timestamp: '2024-01-01T10:00:00.000' }],
    code: null,
    ...overrides,
  };
}

/**
 * Answers the run history of a crawler (null: of the crawlers that are not saved) and counts the requests.
 */
function answerRunHistory(crawlerID: string | null, data: unknown[] = []) {
  const counter = { requests: 0 };
  const path = crawlerID === null ? '/crawler-test-runs' : `/crawlers/${crawlerID}/runs`;
  worker.use(
    http.get(`${MANAGER_URL}${path}`, async () => {
      counter.requests += 1;
      return HttpResponse.json({ data, total: data.length, offset: 0, limit: 20 });
    }),
  );
  return counter;
}

function answerEnvironmentVariables(names: string[]) {
  const counter = { requests: 0 };
  worker.use(
    http.get(`${MANAGER_URL}/environment-variables`, async () => {
      counter.requests += 1;
      return HttpResponse.json({
        data: names.map((name) => ({
          name,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })),
      });
    }),
  );
  return counter;
}

const runButton = () => page.getByRole('button', { name: /^Run/ });
const urlInput = () => page.getByPlaceholder('https://example.com');
const nameField = () => page.getByLabelText('Crawler name');
const declareInput = () => page.getByPlaceholder('API_TOKEN');

describe('CrawlerEditorPage — test runner routes', () => {
  beforeEach(() => {
    window.localStorage.setItem(TEST_PANEL_STORAGE_KEY, 'open');
  });

  afterEach(() => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);
  });

  test('a saved crawler without changes is run directly with POST /crawlers/:id/runs and { input: { url } }', async () => {
    answerRunHistory('c1');
    let captured: { authorization: string | null; body: unknown } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async ({ request }) => {
        captured = { authorization: request.headers.get('Authorization'), body: await request.json() };
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByText('Runs the saved crawler.')).toBeVisible();
    await expect.element(runButton()).toBeDisabled();

    await urlInput().fill('https://example.com/page');
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(captured).toEqual({
      authorization: 'Bearer test-access-token',
      body: { input: { url: 'https://example.com/page' } },
    });
  });

  test('a saved crawler with changes is test-run with POST /crawlers/:id/test-runs and the draft', async () => {
    answerRunHistory('c1');
    const calls = { direct: 0, draft: 0 };
    let capturedBody: unknown;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => {
        calls.direct += 1;
        return HttpResponse.json(completedRun());
      }),
      http.post(`${MANAGER_URL}/crawlers/c1/test-runs`, async ({ request }) => {
        calls.draft += 1;
        capturedBody = await request.json();
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();
    await nameField().fill('Renamed');
    await urlInput().fill('https://example.com/page');

    await expect.element(page.getByText('Test run of unsaved changes.')).toBeVisible();
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(calls).toEqual({ direct: 0, draft: 1 });
    expect(capturedBody).toEqual({
      code: '(body) => body.length',
      url_pattern: '^https://example\\.com',
      environment_variable_names: [],
      input: { url: 'https://example.com/page' },
    });
  });

  test('the route follows the changes: reverting them goes back to a direct run', async () => {
    answerRunHistory('c1');
    const calls = { direct: 0, draft: 0 };
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => {
        calls.direct += 1;
        return HttpResponse.json(completedRun());
      }),
      http.post(`${MANAGER_URL}/crawlers/c1/test-runs`, async () => {
        calls.draft += 1;
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();
    await urlInput().fill('https://example.com/page');
    await expect.element(page.getByText('Runs the saved crawler.')).toBeVisible();

    await nameField().fill('Renamed');
    await expect.element(page.getByText('Test run of unsaved changes.')).toBeVisible();

    await nameField().fill('Detail Crawler');
    await expect.element(page.getByText('Runs the saved crawler.')).toBeVisible();

    await runButton().click();
    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(calls).toEqual({ direct: 1, draft: 0 });
  });

  test('a crawler that is not saved is test-run with POST /crawler-test-runs and its type', async () => {
    answerRunHistory(null);
    let capturedBody: unknown;
    worker.use(
      http.post(`${MANAGER_URL}/crawler-test-runs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(completedRun({ run_id: null }));
      }),
    );

    await renderPage('/crawlers/new');

    await expect.element(page.getByText('Test run of a crawler that is not saved yet.')).toBeVisible();
    await urlInput().fill('https://example.com/page');
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    // Without a URL pattern the request carries none, so the crawler manager does not warn about it
    expect(capturedBody).toEqual({
      type: 'web',
      code: DEFAULT_CODE,
      environment_variable_names: [],
      input: { url: 'https://example.com/page' },
    });
  });

  test('a crawler that is not saved sends the URL pattern, the declared names and the code it has', async () => {
    answerRunHistory(null);
    answerEnvironmentVariables(['API_TOKEN']);
    let capturedBody: unknown;
    worker.use(
      http.post(`${MANAGER_URL}/crawler-test-runs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(completedRun({ run_id: null }));
      }),
    );

    await renderPage('/crawlers/new');
    await page.getByLabelText('URL pattern').fill('  ^https://new\\.example  ');
    await declareInput().fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();
    await urlInput().fill('https://new.example/page');
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(capturedBody).toEqual({
      type: 'web',
      code: DEFAULT_CODE,
      url_pattern: '^https://new\\.example',
      environment_variable_names: ['API_TOKEN'],
      input: { url: 'https://new.example/page' },
    });
  });

  test('a run that is recorded reloads the run history', async () => {
    const history = answerRunHistory('c1');
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => HttpResponse.json(completedRun())),
    );

    await renderPage('/crawlers/c1');
    await expect.element(page.getByText('No runs yet.')).toBeVisible();
    expect(history.requests).toBe(1);

    await urlInput().fill('https://example.com/page');
    await runButton().click();

    await vi.waitFor(() => {
      expect(history.requests).toBe(2);
    });
  });

  test('shows the limit of the code length as 1,048,576', async () => {
    worker.use(http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)));

    await renderPage('/crawlers/c1');

    await expect.element(page.getByText(/\/ 1,048,576$/)).toBeVisible();
  });
});

describe('CrawlerEditorPage — data crawler input', () => {
  beforeEach(() => {
    window.localStorage.setItem(TEST_PANEL_STORAGE_KEY, 'open');
  });

  afterEach(() => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);
  });

  test('has a JSON input instead of the URL and runs with no input while it is empty', async () => {
    answerRunHistory('c1');
    let capturedBody: unknown;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(dataCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');

    await expect.element(page.getByLabelText('Input (JSON)')).toBeVisible();
    expect(urlInput().query()).toBeNull();
    await expect.element(runButton()).toBeEnabled();

    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    // No input at all: the crawler manager builds it from the input schema
    expect(capturedBody).toEqual({});
  });

  test('sends the JSON that was typed as the input', async () => {
    answerRunHistory('c1');
    let capturedBody: unknown;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(dataCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');

    await page.getByLabelText('Input (JSON)').fill('{"userIds": ["a", "b"]}');
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(capturedBody).toEqual({ input: { userIds: ['a', 'b'] } });
  });

  test('does not request anything for a JSON that is wrong and shows the error at the input', async () => {
    answerRunHistory('c1');
    let runs = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(dataCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => {
        runs += 1;
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');

    const input = page.getByLabelText('Input (JSON)');
    await input.fill('{"userIds": [');
    await runButton().click();

    await expect
      .element(page.getByRole('alert').filter({ hasText: 'Input must be valid JSON.' }))
      .toBeVisible();
    await expect.element(input).toHaveAttribute('aria-invalid', 'true');
    expect(runs).toBe(0);
    // The result stays as it was: nothing ran
    await expect.element(page.getByText('Run a test to see results here.')).toBeVisible();

    await input.fill('{"userIds": []}');

    await expect.element(page.getByText('Input must be valid JSON.')).not.toBeInTheDocument();
    await runButton().click();
    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(runs).toBe(1);
  });

  test('a test run sends the input schema of the editor', async () => {
    answerRunHistory('c1');
    let capturedBody: unknown;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(dataCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/test-runs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();
    await page.getByLabelText('Input schema').fill('{"userIds":"string[]","limit":"number"}');
    await page.getByLabelText('Input (JSON)').fill('{"userIds": ["a"], "limit": 2}');
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(capturedBody).toEqual({
      code: '(body) => body.length',
      input_schema: { userIds: 'string[]', limit: 'number' },
      environment_variable_names: [],
      input: { userIds: ['a'], limit: 2 },
    });
  });

  test('does not run changes whose input schema is not valid JSON', async () => {
    answerRunHistory('c1');
    let runs = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(dataCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/test-runs`, async () => {
        runs += 1;
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();
    await page.getByLabelText('Input schema').fill('{ not json');

    await expect.element(page.getByText('Fix the input schema before running.')).toBeVisible();
    await expect.element(runButton()).toBeDisabled();
    expect(runs).toBe(0);
  });

  test('a crawler that is not saved is always a web crawler with the URL input', async () => {
    answerRunHistory(null);

    await renderPage('/crawlers/new');

    await expect.element(urlInput()).toBeVisible();
    expect(page.getByLabelText('Input (JSON)').query()).toBeNull();
  });
});

describe('CrawlerEditorPage — result, logs and failures', () => {
  beforeEach(() => {
    window.localStorage.setItem(TEST_PANEL_STORAGE_KEY, 'open');
  });

  afterEach(() => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);
  });

  async function runOnce(respond: () => Response) {
    answerRunHistory('c1');
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => respond()),
    );
    await renderPage('/crawlers/c1');
    await urlInput().fill('https://example.com/page');
    await runButton().click();
  }

  test('shows the logs of the crawler under the result: the level, the time and the message', async () => {
    await runOnce(() =>
      HttpResponse.json(
        completedRun({
          logs: [
            { level: 'info', message: 'fetched the page', timestamp: '2024-01-01T10:00:00.000' },
            { level: 'warn', message: 'selector is slow', timestamp: '2024-01-01T10:00:01.000' },
          ],
        }),
      ),
    );

    const logs = page.getByRole('log', { name: 'Crawler logs' });
    await expect.element(logs).toHaveTextContent('[10:00:00]INFOfetched the page');
    await expect.element(logs).toHaveTextContent('[10:00:01]WARNselector is slow');
    expect(page.getByText('Logs were truncated.').query()).toBeNull();
  });

  test('shows no line of its own: a run without logs says there are none', async () => {
    await runOnce(() => HttpResponse.json(completedRun({ logs: [] })));

    await expect.element(page.getByText('No logs.')).toBeVisible();
    expect(page.getByText(/Starting test execution|Execution completed|Execution failed/).query()).toBeNull();
  });

  test('says that the logs were cut when logs_truncated is true', async () => {
    await runOnce(() => HttpResponse.json(completedRun({ logs_truncated: true })));

    await expect.element(page.getByText('Logs were truncated.')).toBeVisible();
  });

  test('a failed run shows its error code, description and logs, and is not an error of the request', async () => {
    await runOnce(() => HttpResponse.json(failedRun({ logs_truncated: true }), { status: 422 }));

    await expect.element(page.getByText('execution_failed')).toBeVisible();
    await expect.element(page.getByText('TypeError: body is not a function')).toBeVisible();
    await expect.element(page.getByRole('log', { name: 'Crawler logs' })).toHaveTextContent('[10:00:00]ERRORboom');
    await expect.element(page.getByText('Logs were truncated.')).toBeVisible();
    expect(page.getByRole('button', { name: 'Copy' }).query()).toBeNull();
  });

  test('an error without a run shows its error_description and no logs', async () => {
    await runOnce(() =>
      HttpResponse.json(
        { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
        { status: 503 },
      ),
    );

    await expect.element(page.getByText('Environment variables are not available right now')).toBeVisible();
    expect(page.getByRole('log', { name: 'Crawler logs' }).query()).toBeNull();
  });

  test('shows Executing... while the run is going', async () => {
    answerRunHistory('c1');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => {
        await gate;
        return HttpResponse.json(completedRun());
      }),
    );

    await renderPage('/crawlers/c1');
    await urlInput().fill('https://example.com/page');
    await runButton().click();

    await expect.element(page.getByText('Executing...')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /^Running/ })).toBeDisabled();
    await expect.element(urlInput()).toBeDisabled();

    release();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
  });
});

describe('CrawlerEditorPage — files', () => {
  beforeEach(() => {
    window.localStorage.setItem(TEST_PANEL_STORAGE_KEY, 'open');
  });

  afterEach(() => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);
  });

  const resultWithFiles = {
    pages: [
      { screenshot: { file_id: FILE_ID, content_type: 'image/png', size: 2048, name: 'home.png' } },
      [{ file_id: OTHER_FILE_ID, content_type: 'application/pdf', size: 12, name: null }],
    ],
  };

  async function runWithFiles() {
    answerRunHistory('c1');
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => {
        return HttpResponse.json(completedRun({ result: resultWithFiles }));
      }),
    );
    await renderPage('/crawlers/c1');
    await urlInput().fill('https://example.com/page');
    await runButton().click();
  }

  test('finds the file references anywhere in the result and lists their name, type and size', async () => {
    await runWithFiles();

    await expect.element(page.getByText('Files', { exact: true })).toBeVisible();
    await expect.element(page.getByText('image/png · 2.0 KB')).toBeVisible();
    await expect.element(page.getByText('application/pdf · 12 B')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Download home.png' })).toBeVisible();
    // A reference without a name is shown under its id
    await expect.element(page.getByRole('button', { name: `Download ${OTHER_FILE_ID}` })).toBeVisible();
  });

  test('Download gets GET /files/:id with the token and saves the blob under the name of the reference', async () => {
    let captured: { pathname: string; authorization: string | null } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/files/${FILE_ID}`, async ({ request }) => {
        captured = { pathname: new URL(request.url).pathname, authorization: request.headers.get('Authorization') };
        return new HttpResponse('png bytes', { headers: { 'Content-Type': 'image/png' } });
      }),
    );
    const saved: string[] = [];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });

    try {
      await runWithFiles();

      await page.getByRole('button', { name: 'Download home.png' }).click();

      await vi.waitFor(() => {
        expect(saved).toEqual(['home.png']);
      });
      expect(captured).toEqual({ pathname: `/files/${FILE_ID}`, authorization: 'Bearer test-access-token' });
    } finally {
      createObjectURL.mockRestore();
      click.mockRestore();
    }
  });

  test('a file that is gone says File not found or expired', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/files/${OTHER_FILE_ID}`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'File not found' }, { status: 404 });
      }),
    );

    await runWithFiles();

    await page.getByRole('button', { name: `Download ${OTHER_FILE_ID}` }).click();

    await expect.element(page.getByText('File not found or expired')).toBeVisible();
  });
});

describe('CrawlerEditorPage — run history', () => {
  beforeEach(() => {
    window.localStorage.setItem(TEST_PANEL_STORAGE_KEY, 'open');
  });

  afterEach(() => {
    window.localStorage.removeItem(TEST_PANEL_STORAGE_KEY);
  });

  test('lists the direct and test runs of a saved crawler, with the error code of a failed one', async () => {
    answerRunHistory('c1', [
      runSummary(1, { kind: 'test' }),
      runSummary(2, { kind: 'direct', status: 'failed', error_code: 'execution_failed' }),
    ]);
    worker.use(http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)));

    await renderPage('/crawlers/c1');

    await expect.element(page.getByRole('heading', { name: 'Run history' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /^Test / })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /^Direct / })).toHaveTextContent('execution_failed');
    await expect.element(page.getByRole('button', { name: /^Direct / })).toHaveTextContent('2s');
  });

  test('a crawler that is not saved lists the test runs without a crawler', async () => {
    const history = answerRunHistory(null, [runSummary(1, { crawler_id: null, kind: 'test' })]);

    await renderPage('/crawlers/new');

    await expect.element(page.getByRole('button', { name: /^Test / })).toBeVisible();
    expect(history.requests).toBe(1);
  });

  test('a row opens the run: its result, logs and files take the place of the result', async () => {
    const pastRun = runSummary(1, { kind: 'test' });
    answerRunHistory('c1', [pastRun]);
    let detailRequests = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.get(`${MANAGER_URL}/crawlers/c1/runs/${pastRun.id}`, async () => {
        detailRequests += 1;
        return HttpResponse.json(
          runDetail(1, {
            kind: 'test',
            code: 'return 1',
            logs_truncated: true,
            result: {
              title: 'Past title',
              report: { file_id: FILE_ID, content_type: 'text/csv', size: 10, name: 'past.csv' },
            },
          }),
        );
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /^Test / }).click();

    await expect.element(page.getByText('"Past title"')).toBeVisible();
    await expect.element(page.getByText(/Showing a past test run from/)).toBeVisible();
    await expect.element(page.getByRole('log', { name: 'Crawler logs' })).toHaveTextContent('past log line');
    await expect.element(page.getByText('Logs were truncated.')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Download past.csv' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /^Test / })).toHaveAttribute('aria-current', 'true');
    expect(detailRequests).toBe(1);
  });

  test('a failed run opens with its error code and description', async () => {
    const pastRun = runSummary(1, { status: 'failed', error_code: 'execution_failed' });
    answerRunHistory('c1', [pastRun]);
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.get(`${MANAGER_URL}/crawlers/c1/runs/${pastRun.id}`, async () => {
        return HttpResponse.json(
          runDetail(1, {
            status: 'failed',
            result: null,
            error_code: 'execution_failed',
            error: 'ReferenceError: x is not defined',
          }),
        );
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /^Direct / }).click();

    await expect.element(page.getByText('ReferenceError: x is not defined')).toBeVisible();
    await expect.element(page.getByText(/Showing a past run from/)).toBeVisible();
  });

  test('opens a test run of a crawler that is not saved with GET /crawler-test-runs/:runID', async () => {
    const pastRun = runSummary(1, { crawler_id: null, kind: 'test' });
    answerRunHistory(null, [pastRun]);
    let detailPath = '';
    worker.use(
      http.get(`${MANAGER_URL}/crawler-test-runs/${pastRun.id}`, async ({ request }) => {
        detailPath = new URL(request.url).pathname;
        return HttpResponse.json(runDetail(1, { crawler_id: null, kind: 'test', code: 'return 1' }));
      }),
    );

    await renderPage('/crawlers/new');
    await page.getByRole('button', { name: /^Test / }).click();

    await expect.element(page.getByText('"Past title"')).toBeVisible();
    expect(detailPath).toBe(`/crawler-test-runs/${pastRun.id}`);
  });

  test('shows the error_description when the run cannot be opened', async () => {
    const pastRun = runSummary(1);
    answerRunHistory('c1', [pastRun]);
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.get(`${MANAGER_URL}/crawlers/c1/runs/${pastRun.id}`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Crawler run not found' }, { status: 404 });
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /^Direct / }).click();

    await expect.element(page.getByText('Crawler run not found')).toBeVisible();
  });

  test('running again puts the new result back in place of the opened run', async () => {
    const pastRun = runSummary(1);
    answerRunHistory('c1', [pastRun]);
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.get(`${MANAGER_URL}/crawlers/c1/runs/${pastRun.id}`, async () => HttpResponse.json(runDetail(1))),
      http.post(`${MANAGER_URL}/crawlers/c1/runs`, async () => HttpResponse.json(completedRun())),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /^Direct / }).click();
    await expect.element(page.getByText('"Past title"')).toBeVisible();

    await urlInput().fill('https://example.com/page');
    await runButton().click();

    await expect.element(page.getByText('"Hello"')).toBeVisible();
    expect(page.getByText('"Past title"').query()).toBeNull();
    expect(page.getByText(/Showing a past/).query()).toBeNull();
  });
});

describe('CrawlerEditorPage — environment variables', () => {
  test('shows the declared names in view mode with Set or Not set and a link to Settings', async () => {
    answerEnvironmentVariables(['API_TOKEN']);
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json({ ...mockCrawler, environment_variable_names: ['API_TOKEN', 'OTHER_TOKEN'] });
      }),
    );

    await renderPage('/crawlers/c1');

    const registered = page.getByRole('listitem').filter({ hasText: 'API_TOKEN' });
    const missing = page.getByRole('listitem').filter({ hasText: 'OTHER_TOKEN' });
    // The typing of toHaveTextContent takes a string only, so the exact match is polled on the text
    await expect.poll(() => registered.element().textContent).toMatch(/^API_TOKEN\s*Set$/);
    await expect.element(missing).toHaveTextContent('Not set');
    expect(declareInput().query()).toBeNull();
    expect(page.getByRole('button', { name: 'Remove OTHER_TOKEN' }).query()).toBeNull();

    await page.getByRole('link', { name: 'Set OTHER_TOKEN in Settings' }).click();

    await expect.element(page.getByText('Settings Page')).toBeVisible();
  });

  test('does not ask for the account list while no name is declared', async () => {
    const environmentVariables = answerEnvironmentVariables(['API_TOKEN']);
    worker.use(http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)));

    await renderPage('/crawlers/c1');

    await expect.element(page.getByText('No environment variables declared.')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(environmentVariables.requests).toBe(0);
  });

  test('says why Set or Not set is unknown when the account list cannot be read', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json({ ...mockCrawler, environment_variable_names: ['API_TOKEN'] });
      }),
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    await renderPage('/crawlers/c1');

    await expect
      .element(page.getByText('Could not check which names are set: Environment variables are not available right now'))
      .toBeVisible();
    await expect
      .element(page.getByRole('listitem').filter({ hasText: 'API_TOKEN' }))
      .not.toHaveTextContent('Not set');
  });

  test('adds a name in edit mode: the form is dirty and Save sends the names', async () => {
    answerEnvironmentVariables([]);
    answerRunHistory('c1');
    let capturedBody: Record<string, unknown> | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.put(`${MANAGER_URL}/crawlers/c1`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockCrawler, environment_variable_names: ['API_TOKEN'] });
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();
    expect(page.getByText('Unsaved').query()).toBeNull();

    await declareInput().fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();

    await expect.element(page.getByText('Unsaved')).toBeVisible();
    await expect
      .element(page.getByRole('listitem').filter({ hasText: 'API_TOKEN' }))
      .toHaveTextContent('Not set');

    await page.getByRole('button', { name: /Save/ }).click();

    await vi.waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    expect(capturedBody?.environment_variable_names).toEqual(['API_TOKEN']);
    await expect.element(page.getByRole('button', { name: /Edit crawler/ })).toBeVisible();
    await expect.element(page.getByRole('listitem').filter({ hasText: 'API_TOKEN' })).toBeVisible();
  });

  test('removing a name is a change, and putting it back is not', async () => {
    answerEnvironmentVariables(['API_TOKEN']);
    answerRunHistory('c1');
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => {
        return HttpResponse.json({ ...mockCrawler, environment_variable_names: ['API_TOKEN'] });
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();

    await page.getByRole('button', { name: 'Remove API_TOKEN' }).click();
    await expect.element(page.getByText('Unsaved')).toBeVisible();

    await declareInput().fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();
    await expect.element(page.getByText('Unsaved')).not.toBeInTheDocument();
  });

  test('refuses a name that breaks the rule before anything is saved', async () => {
    answerEnvironmentVariables([]);
    answerRunHistory('c1');
    let puts = 0;
    worker.use(
      http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)),
      http.put(`${MANAGER_URL}/crawlers/c1`, async () => {
        puts += 1;
        return HttpResponse.json(mockCrawler);
      }),
    );

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();

    await declareInput().fill('api-token');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();

    await expect
      .element(page.getByRole('alert').filter({ hasText: 'Name must match' }))
      .toHaveTextContent('^[A-Z_][A-Z0-9_]{0,63}$');
    expect(page.getByText('Unsaved').query()).toBeNull();
    expect(puts).toBe(0);
  });

  test('the names are part of the create payload', async () => {
    answerEnvironmentVariables([]);
    answerRunHistory(null);
    let capturedBody: Record<string, unknown> | undefined;
    worker.use(
      http.post(`${MANAGER_URL}/crawlers`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockCrawler, id: 'c-new', environment_variable_names: ['API_TOKEN'] });
      }),
      http.get(`${MANAGER_URL}/crawlers/c-new`, async () => {
        return HttpResponse.json({ ...mockCrawler, id: 'c-new', environment_variable_names: ['API_TOKEN'] });
      }),
    );

    await renderPage('/crawlers/new');
    await nameField().fill('With Token');
    await page.getByLabelText('URL pattern').fill('^https://new\\.example');
    await declareInput().fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();
    await page.getByRole('button', { name: /Submit/ }).click();

    await vi.waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    expect(capturedBody).toMatchObject({
      name: 'With Token',
      url_pattern: '^https://new\\.example',
      environment_variable_names: ['API_TOKEN'],
    });
  });

  test('Cancel drops the names that were added', async () => {
    answerEnvironmentVariables([]);
    answerRunHistory('c1');
    worker.use(http.get(`${MANAGER_URL}/crawlers/c1`, async () => HttpResponse.json(mockCrawler)));

    await renderPage('/crawlers/c1');
    await page.getByRole('button', { name: /Edit crawler/ }).click();
    await declareInput().fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();
    await expect.element(page.getByText('Unsaved')).toBeVisible();

    await page.getByRole('button', { name: /Cancel/ }).click();
    await page.getByRole('button', { name: 'Discard' }).click();

    await expect.element(page.getByText('No environment variables declared.')).toBeVisible();
  });
});
