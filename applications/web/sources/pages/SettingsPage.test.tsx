import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page, userEvent } from 'vitest/browser';
import { test, expect } from '../tests/extensions.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { ToastProvider } from '../contexts/ToastContext.tsx';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { worker } from '../tests/mocks/browser.ts';

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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <AuthenticationContext.Provider value={createAuth()}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>
    </AuthenticationContext.Provider>,
  );
}

// The format of the section, so that the expected text follows the locale of the browser
function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function summary(name: string) {
  return { name, created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z' };
}

/**
 * A stateful list: GET answers what the account holds now, PUT adds or replaces, DELETE removes.
 */
function answerAccount(initialNames: string[]) {
  const names = [...initialNames];
  const requests: { method: string; name?: string; body?: unknown }[] = [];
  worker.use(
    http.get(`${MANAGER_URL}/environment-variables`, async () => {
      requests.push({ method: 'GET' });
      return HttpResponse.json({ data: names.map(summary) });
    }),
    http.put(`${MANAGER_URL}/environment-variables/:name`, async ({ params, request }) => {
      const name = String(params.name);
      requests.push({ method: 'PUT', name, body: await request.json() });
      const created = !names.includes(name);
      if (created) names.push(name);
      return HttpResponse.json(summary(name), { status: created ? 201 : 200 });
    }),
    http.delete(`${MANAGER_URL}/environment-variables/:name`, async ({ params }) => {
      const name = String(params.name);
      requests.push({ method: 'DELETE', name });
      const index = names.indexOf(name);
      if (index === -1) {
        return HttpResponse.json({ error: 'not_found', error_description: 'Environment variable not found' }, { status: 404 });
      }
      names.splice(index, 1);
      return HttpResponse.json({ deleted: true });
    }),
  );
  return { names, requests };
}

// The page also holds the provider key sections: they answer an account without keys or history,
// and a test that needs more registers its own handlers, which come first
beforeEach(() => {
  worker.use(
    http.get(`${MANAGER_URL}/provider-keys`, async () => {
      return HttpResponse.json({
        data: ['anthropic', 'openai', 'google', 'xai'].map((provider) => ({ provider, configured: false, last4: null, validated_at: null })),
      });
    }),
    http.get(`${MANAGER_URL}/provider-keys/audit`, async () => HttpResponse.json({ data: [] })),
  );
});

const nameInput = () => page.getByLabelText('Name', { exact: true });
const valueInput = () => page.getByLabelText('Value', { exact: true });
const addButton = () => page.getByRole('button', { name: 'Add', exact: true });

describe('SettingsPage — list', () => {
  test('shows the page title, the navigation with Settings and the Environment variables section', async () => {
    answerAccount([]);

    await renderPage();

    await expect.element(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Environment variables' })).toBeVisible();
    await expect.element(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  test('shows the provider keys and their history below the environment variables', async () => {
    answerAccount([]);

    await renderPage();

    await expect.element(page.getByRole('group', { name: 'Google', exact: true })).toHaveTextContent('Not set');
    await expect.element(page.getByText('No provider key history yet.')).toBeVisible();
    const headings = page
      .getByRole('heading', { level: 2 })
      .elements()
      .map((element) => element.textContent);
    expect(headings).toEqual(['Environment variables', 'Provider keys', 'Provider key history']);
  });

  test('lists the names with their created and changed times and the count out of 100', async () => {
    answerAccount(['API_TOKEN', 'BLOG_A_TOKEN']);

    await renderPage();

    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
    await expect.element(page.getByText('BLOG_A_TOKEN', { exact: true })).toBeVisible();
    await expect.element(page.getByLabelText('2 of 100 used')).toHaveTextContent('2 / 100');
    // The browser writes a narrow no-break space before AM or PM; the page text is matched with spaces collapsed
    const created = formatDateTime('2024-01-01T00:00:00.000Z').replace(/\s+/g, ' ');
    const changed = formatDateTime('2024-01-02T00:00:00.000Z').replace(/\s+/g, ' ');
    // One created time and one changed time on each of the two rows
    await vi.waitFor(() => {
      const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
      expect(text.split(created)).toHaveLength(3);
      expect(text.split(changed)).toHaveLength(3);
    });
  });

  test('says that there are no variables yet', async () => {
    answerAccount([]);

    await renderPage();

    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();
    await expect.element(page.getByLabelText('0 of 100 used')).toHaveTextContent('0 / 100');
  });

  test('shows the error_description of a failed list, and Retry loads it again', async () => {
    let requests = 0;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        requests += 1;
        if (requests === 1) {
          return HttpResponse.json(
            { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
            { status: 503 },
          );
        }
        return HttpResponse.json({ data: [summary('API_TOKEN')] });
      }),
    );

    await renderPage();

    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Failed to load environment variables: Environment variables are not available right now');

    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
  });

  test('says that a value is never shown again', async () => {
    answerAccount(['API_TOKEN']);

    await renderPage();

    await expect.element(page.getByText(/never shown again/)).toBeVisible();
    // Only the name of a variable is on the row; there is nothing to read a value from
    await expect.element(page.getByRole('button', { name: 'Change value of API_TOKEN' })).toBeVisible();
    expect(page.getByLabelText('New value').query()).toBeNull();
  });
});

describe('SettingsPage — add', () => {
  test('adds a variable with PUT, clears the value the moment it is submitted, and then clears the name', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored: { name: string; body: unknown }[] = [];
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        return HttpResponse.json({ data: stored.map(({ name }) => summary(name)) });
      }),
      http.put(`${MANAGER_URL}/environment-variables/:name`, async ({ params, request }) => {
        const body = await request.json();
        await gate;
        stored.push({ name: String(params.name), body });
        return HttpResponse.json(summary(String(params.name)), { status: 201 });
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    await addButton().click();

    // The request is still waiting, and the value has left the input already
    await expect.element(valueInput()).toHaveValue('');
    await expect.element(nameInput()).toHaveValue('API_TOKEN');

    release();

    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
    await expect.element(nameInput()).toHaveValue('');
    expect(stored).toEqual([{ name: 'API_TOKEN', body: { value: 'secret-value' } }]);
    await expect.element(page.getByText('API_TOKEN has been added.')).toBeVisible();
    expect(document.body.textContent).not.toContain('secret-value');
  });

  test('shows and hides the typed value with the toggle', async () => {
    answerAccount([]);

    await renderPage();

    await expect.element(valueInput()).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Show value' }).click();
    await expect.element(valueInput()).toHaveAttribute('type', 'text');
    await expect.element(page.getByRole('button', { name: 'Hide value' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Hide value' }).click();
    await expect.element(valueInput()).toHaveAttribute('type', 'password');
  });

  test('checks the name before it asks the server', async () => {
    const { requests } = answerAccount([]);

    await renderPage();
    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();

    await nameInput().fill('api-token');
    await valueInput().fill('secret-value');
    await addButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('^[A-Z_][A-Z0-9_]{0,63}$');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
    // A name that was refused leaves the value where it was typed
    await expect.element(valueInput()).toHaveValue('secret-value');
  });

  test('checks the length of the value before it asks the server', async () => {
    const { requests } = answerAccount([]);

    await renderPage();
    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('abc');
    await addButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Value must be 4 to 16,384 characters.');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  });

  test('does not add a name that exists and points to Change value', async () => {
    const { requests } = answerAccount(['API_TOKEN']);

    await renderPage();
    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    await addButton().click();

    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('API_TOKEN already exists. Use "Change value" on its row to update it.');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  });

  test('cannot add while the list is loading, because the existing names are not known yet', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const puts: string[] = [];
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        await gate;
        return HttpResponse.json({ data: [summary('API_TOKEN')] });
      }),
      http.put(`${MANAGER_URL}/environment-variables/:name`, async ({ params }) => {
        puts.push(String(params.name));
        return HttpResponse.json(summary(String(params.name)), { status: 200 });
      }),
    );

    await renderPage();
    await expect.element(page.getByText('Loading environment variables...')).toBeVisible();

    await expect.element(addButton()).toBeDisabled();
    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    // Enter in an input does not submit through a disabled Add button either
    await valueInput().click();
    await userEvent.keyboard('{Enter}');
    expect(puts).toEqual([]);

    release();

    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
    await expect.element(addButton()).toBeEnabled();
    await addButton().click();
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('API_TOKEN already exists. Use "Change value" on its row to update it.');
    expect(puts).toEqual([]);
  });

  test('cannot add while the list failed to load, and can again once Retry loads it', async () => {
    let requests = 0;
    const puts: string[] = [];
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => {
        requests += 1;
        if (requests === 1) {
          return HttpResponse.json(
            { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
            { status: 503 },
          );
        }
        return HttpResponse.json({ data: [summary('API_TOKEN')] });
      }),
      http.put(`${MANAGER_URL}/environment-variables/:name`, async ({ params }) => {
        puts.push(String(params.name));
        return HttpResponse.json(summary(String(params.name)), { status: 200 });
      }),
    );

    await renderPage();
    await expect.element(page.getByRole('alert')).toHaveTextContent('Failed to load environment variables');

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    await expect.element(addButton()).toBeDisabled();
    expect(puts).toEqual([]);
    // Nothing was submitted, so what was typed stays where it was
    await expect.element(valueInput()).toHaveValue('secret-value');

    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
    await expect.element(addButton()).toBeEnabled();
  });

  test('says that the value was replaced when the server answers 200 to an add of a name the list did not have', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => HttpResponse.json({ data: [] })),
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(summary('API_TOKEN'), { status: 200 });
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    await addButton().click();

    await expect.element(page.getByText('API_TOKEN already existed, so its value has been replaced.')).toBeVisible();
    expect(page.getByText('API_TOKEN has been added.').query()).toBeNull();
  });

  test('does not add a 101st variable', async () => {
    const { requests } = answerAccount(Array.from({ length: 100 }, (_, index) => `NAME_${index}`));

    await renderPage();
    await expect.element(page.getByLabelText('100 of 100 used')).toBeVisible();

    await nameInput().fill('ONE_MORE');
    await valueInput().fill('secret-value');
    await addButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('At most 100 environment variables are allowed.');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  });

  test('shows the limit that the server reports with a 409, and the value stays cleared', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => HttpResponse.json({ data: [] })),
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'limit_exceeded', error_description: 'At most 100 environment variables are allowed' },
          { status: 409 },
        );
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    await addButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('At most 100 environment variables are allowed');
    await expect.element(valueInput()).toHaveValue('');
    await expect.element(nameInput()).toHaveValue('API_TOKEN');
  });

  test('shows that the storage is not available with a 503', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => HttpResponse.json({ data: [] })),
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    await renderPage();
    await expect.element(page.getByText('No environment variables yet.')).toBeVisible();

    await nameInput().fill('API_TOKEN');
    await valueInput().fill('secret-value');
    await addButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Environment variables are not available right now');
    await expect.element(valueInput()).toHaveValue('');
  });
});

describe('SettingsPage — change value', () => {
  test('opens a password input on the row, saves with PUT, clears the input at submit and closes the form', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured: { name: string; body: unknown } | undefined;
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => HttpResponse.json({ data: [summary('API_TOKEN')] })),
      http.put(`${MANAGER_URL}/environment-variables/:name`, async ({ params, request }) => {
        captured = { name: String(params.name), body: await request.json() };
        await gate;
        return HttpResponse.json(summary(String(params.name)), { status: 200 });
      }),
    );

    await renderPage();

    await page.getByRole('button', { name: 'Change value of API_TOKEN' }).click();

    const newValue = page.getByLabelText('New value');
    await expect.element(newValue).toHaveAttribute('type', 'password');
    await newValue.fill('another-secret');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.element(newValue).toHaveValue('');

    release();

    await expect.element(page.getByLabelText('New value')).not.toBeInTheDocument();
    expect(captured).toEqual({ name: 'API_TOKEN', body: { value: 'another-secret' } });
    await expect.element(page.getByText('API_TOKEN has been changed.')).toBeVisible();
    expect(document.body.textContent).not.toContain('another-secret');
  });

  test('checks the length of the new value before it asks the server', async () => {
    const { requests } = answerAccount(['API_TOKEN']);

    await renderPage();
    await page.getByRole('button', { name: 'Change value of API_TOKEN' }).click();

    await page.getByLabelText('New value').fill('abc');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Value must be 4 to 16,384 characters.');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
  });

  test('Cancel closes the form and drops what was typed', async () => {
    answerAccount(['API_TOKEN']);

    await renderPage();
    await page.getByRole('button', { name: 'Change value of API_TOKEN' }).click();
    await page.getByLabelText('New value').fill('half-typed');

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect.element(page.getByLabelText('New value')).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Change value of API_TOKEN' }).click();
    await expect.element(page.getByLabelText('New value')).toHaveValue('');
  });

  test('shows a 503 on the row and keeps the form open with an empty input', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => HttpResponse.json({ data: [summary('API_TOKEN')] })),
      http.put(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    await renderPage();
    await page.getByRole('button', { name: 'Change value of API_TOKEN' }).click();
    await page.getByLabelText('New value').fill('another-secret');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Environment variables are not available right now');
    await expect.element(page.getByLabelText('New value')).toHaveValue('');
  });
});

describe('SettingsPage — delete', () => {
  test('asks for confirmation, and Cancel deletes nothing', async () => {
    const { requests } = answerAccount(['API_TOKEN']);

    await renderPage();
    await page.getByRole('button', { name: 'Delete API_TOKEN' }).click();

    await expect.element(page.getByRole('alertdialog')).toBeVisible();
    await expect.element(page.getByRole('alertdialog')).toHaveTextContent('Delete API_TOKEN?');

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
  });

  test('deletes the variable with DELETE after the confirmation and removes the row', async () => {
    const { requests } = answerAccount(['API_TOKEN', 'BLOG_A_TOKEN']);

    await renderPage();
    await page.getByRole('button', { name: 'Delete API_TOKEN' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();

    await vi.waitFor(() => {
      expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([{ method: 'DELETE', name: 'API_TOKEN' }]);
    });
    await expect.element(page.getByText('API_TOKEN has been deleted.')).toBeVisible();
    await expect.element(page.getByLabelText('1 of 100 used')).toHaveTextContent('1 / 100');
    expect(page.getByText('API_TOKEN', { exact: true }).query()).toBeNull();
    await expect.element(page.getByText('BLOG_A_TOKEN', { exact: true })).toBeVisible();
  });

  test('shows the error of a failed delete on the row', async () => {
    worker.use(
      http.get(`${MANAGER_URL}/environment-variables`, async () => HttpResponse.json({ data: [summary('API_TOKEN')] })),
      http.delete(`${MANAGER_URL}/environment-variables/API_TOKEN`, async () => {
        return HttpResponse.json(
          { error: 'service_unavailable', error_description: 'Environment variables are not available right now' },
          { status: 503 },
        );
      }),
    );

    await renderPage();
    await page.getByRole('button', { name: 'Delete API_TOKEN' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Environment variables are not available right now');
    await expect.element(page.getByText('API_TOKEN', { exact: true })).toBeVisible();
  });
});
