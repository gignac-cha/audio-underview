import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { ProviderKeysSection } from './ProviderKeysSection.tsx';
import { ProviderKeyAuditList } from './ProviderKeyAuditList.tsx';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import { worker } from '../../tests/mocks/browser.ts';
import { PROVIDER_NAMES, type ProviderKeyAuditEvent, type ProviderName } from '../../schemas/provider-keys.ts';

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

const VALIDATED_AT = '2026-10-26T01:02:00.000Z';
const ANTHROPIC_KEY = 'sk-ant-api03-test-key-1234';
const GOOGLE_KEY = 'AIzaSyTest-google-key-wxyz';

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ProviderKeysSection />
        <ProviderKeyAuditList />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

// The format of the section, with spaces collapsed: the browser writes a narrow no-break space before AM or PM
function formatDateTime(dateString: string) {
  return new Date(dateString)
    .toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(/\s+/g, ' ');
}

function status(provider: ProviderName, last4: string | undefined) {
  return last4 === undefined
    ? { provider, configured: false, last4: null, validated_at: null }
    : { provider, configured: true, last4, validated_at: VALIDATED_AT };
}

/**
 * A stateful account: GET answers the keys and the history it holds now, PUT registers or replaces,
 * DELETE removes, and each change adds to the history the way the vault does.
 */
function answerAccount(initialKeys: Partial<Record<ProviderName, string>> = {}, initialHistory: ProviderKeyAuditEvent[] = []) {
  const last4s = new Map(Object.entries(initialKeys) as [ProviderName, string][]);
  const history = [...initialHistory];
  const requests: { method: string; provider?: string; body?: unknown }[] = [];
  let minute = 0;
  const nextTime = () => {
    minute += 1;
    return new Date(Date.UTC(2026, 9, 26, 2, minute)).toISOString();
  };
  worker.use(
    http.get(`${MANAGER_URL}/provider-keys`, async () => {
      requests.push({ method: 'GET' });
      return HttpResponse.json({ data: PROVIDER_NAMES.map((provider) => status(provider, last4s.get(provider))) });
    }),
    http.get(`${MANAGER_URL}/provider-keys/audit`, async () => {
      requests.push({ method: 'GET audit' });
      return HttpResponse.json({ data: history });
    }),
    http.put(`${MANAGER_URL}/provider-keys/:provider`, async ({ params, request }) => {
      const provider = String(params.provider) as ProviderName;
      const body = (await request.json()) as { key: string };
      requests.push({ method: 'PUT', provider, body });
      history.unshift({ provider, action: last4s.has(provider) ? 'replaced' : 'registered', at: nextTime() });
      last4s.set(provider, body.key.slice(-4));
      return HttpResponse.json(status(provider, body.key.slice(-4)));
    }),
    http.delete(`${MANAGER_URL}/provider-keys/:provider`, async ({ params }) => {
      const provider = String(params.provider) as ProviderName;
      requests.push({ method: 'DELETE', provider });
      if (!last4s.has(provider)) {
        return HttpResponse.json({ error: 'not_found', error_description: 'Provider key not found' }, { status: 404 });
      }
      last4s.delete(provider);
      history.unshift({ provider, action: 'removed', at: nextTime() });
      return HttpResponse.json({ deleted: true });
    }),
  );
  return { requests };
}

function answerPutError(provider: ProviderName, statusCode: number, error: string, description: string) {
  worker.use(
    http.put(`${MANAGER_URL}/provider-keys/${provider}`, async () => {
      return HttpResponse.json({ error, error_description: description }, { status: statusCode });
    }),
  );
}

const row = (name: string) => page.getByRole('group', { name, exact: true });
const historySection = () => page.getByRole('region', { name: 'Provider key history' });

describe('ProviderKeysSection — list', () => {
  test('shows the four providers in order, each not set, with the notes and a hint to start with Google', async () => {
    answerAccount();

    await renderSection();

    await expect.element(page.getByRole('heading', { name: 'Provider keys', level: 2 })).toBeVisible();
    await expect.element(row('Anthropic')).toBeVisible();
    const titles = page
      .getByRole('heading', { level: 3 })
      .elements()
      .map((element) => element.textContent);
    expect(titles).toEqual(['Anthropic', 'OpenAI', 'Google', 'xAI (Grok)']);
    for (const name of titles) {
      await expect.element(row(String(name))).toHaveTextContent('Not set');
      await expect.element(row(String(name)).getByRole('button', { name: `Register ${name} key` })).toBeVisible();
      expect(
        row(String(name))
          .getByRole('button', { name: /^Remove/ })
          .query(),
      ).toBeNull();
    }

    await expect.element(page.getByText(/encrypted before they are stored and are never displayed again/)).toBeVisible();
    await expect.element(page.getByText(/usage limit for each key with the provider/)).toBeVisible();
    await expect.element(page.getByText(/Newscast audio \(TTS\) always uses your Google key/)).toBeVisible();
    await expect.element(page.getByText(/No provider keys yet/)).toBeVisible();
  });

  test('shows a configured key as its last four characters and the time it was checked', async () => {
    answerAccount({ google: 'wxyz' });

    await renderSection();

    await expect.element(row('Google')).toHaveTextContent('Configured');
    await expect.element(row('Google')).toHaveTextContent('•••• wxyz');
    await expect.element(row('Google')).toHaveTextContent(`Checked ${formatDateTime(VALIDATED_AT)}`);
    await expect.element(row('Google').getByRole('button', { name: 'Replace Google key' })).toBeVisible();
    await expect.element(row('Google').getByRole('button', { name: 'Remove Google key' })).toBeVisible();
    await expect.element(row('Google').getByLabelText('New Google API key')).toBeVisible();
    await expect.element(row('OpenAI')).toHaveTextContent('Not set');
    expect(page.getByText(/No provider keys yet/).query()).toBeNull();
  });

  test('says that the keys are loading', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => {
        await gate;
        return HttpResponse.json({ data: PROVIDER_NAMES.map((provider) => status(provider, undefined)) });
      }),
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => HttpResponse.json({ data: [] })),
    );

    await renderSection();

    await expect.element(page.getByText('Loading provider keys...')).toBeVisible();
    expect(page.getByRole('group').query()).toBeNull();

    release();

    await expect.element(row('Anthropic')).toBeVisible();
  });

  test('shows the error_description of a failed list, and Retry loads it again', async () => {
    let requests = 0;
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => {
        requests += 1;
        if (requests === 1) {
          return HttpResponse.json({ error: 'service_unavailable', error_description: 'Provider keys are not available right now' }, { status: 503 });
        }
        return HttpResponse.json({ data: PROVIDER_NAMES.map((provider) => status(provider, undefined)) });
      }),
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => HttpResponse.json({ data: [] })),
    );

    await renderSection();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Failed to load provider keys: Provider keys are not available right now');
    expect(page.getByRole('group').query()).toBeNull();

    await page.getByRole('button', { name: 'Retry loading provider keys' }).click();

    await expect.element(row('Anthropic')).toBeVisible();
    expect(page.getByRole('alert').query()).toBeNull();
  });
});

describe('ProviderKeysSection — register', () => {
  test('registers a key with PUT, clears the input the moment it is submitted, and shows the key as configured', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { requests } = answerAccount();
    let captured: unknown;
    worker.use(
      http.put(`${MANAGER_URL}/provider-keys/anthropic`, async ({ request }) => {
        // A clone, so that the stateful account below can still read the body
        captured = await request.clone().json();
        await gate;
        // No answer here hands the request on to the stateful account, which stores the key and adds to the history
        return undefined;
      }),
    );

    await renderSection();
    const keyInput = row('Anthropic').getByLabelText('Anthropic API key', { exact: true });
    await keyInput.fill(ANTHROPIC_KEY);
    await row('Anthropic').getByRole('button', { name: 'Show Anthropic key' }).click();
    await expect.element(keyInput).toHaveAttribute('type', 'text');
    await row('Anthropic').getByRole('button', { name: 'Register Anthropic key' }).click();

    // The request is still waiting, and the key has left the input already
    await expect.element(keyInput).toHaveValue('');
    await expect.element(keyInput).toHaveAttribute('type', 'password');
    await expect.element(row('Anthropic').getByRole('status')).toHaveTextContent('Checking the key with Anthropic...');
    await expect.element(row('Anthropic').getByRole('button', { name: 'Register Anthropic key' })).toBeDisabled();
    await vi.waitFor(() => {
      expect(captured).toEqual({ key: ANTHROPIC_KEY });
    });

    release();

    await expect.element(row('Anthropic')).toHaveTextContent('Configured');
    await expect.element(row('Anthropic')).toHaveTextContent('•••• 1234');
    await expect.element(page.getByText('The Anthropic key has been registered.')).toBeVisible();
    // The history is loaded again and shows the registration
    await expect.element(historySection().getByRole('listitem')).toHaveTextContent('Registered');
    expect(requests.filter(({ method }) => method === 'PUT')).toEqual([{ method: 'PUT', provider: 'anthropic', body: { key: ANTHROPIC_KEY } }]);
    expect(document.body.textContent).not.toContain(ANTHROPIC_KEY);
  });

  test('replaces a key that is configured and says so', async () => {
    const { requests } = answerAccount({ google: 'wxyz' });

    await renderSection();
    await row('Google').getByLabelText('New Google API key').fill('AIzaSyTest-google-key-5678');
    await row('Google').getByRole('button', { name: 'Replace Google key' }).click();

    await expect.element(page.getByText('The Google key has been replaced.')).toBeVisible();
    await expect.element(row('Google')).toHaveTextContent('•••• 5678');
    await expect.element(historySection().getByRole('listitem')).toHaveTextContent('Replaced');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
  });

  test('shows and hides the typed key with the toggle', async () => {
    answerAccount();

    await renderSection();
    const keyInput = row('OpenAI').getByLabelText('OpenAI API key', { exact: true });

    await expect.element(keyInput).toHaveAttribute('type', 'password');

    await row('OpenAI').getByRole('button', { name: 'Show OpenAI key' }).click();
    await expect.element(keyInput).toHaveAttribute('type', 'text');
    await expect.element(row('OpenAI').getByRole('button', { name: 'Hide OpenAI key' })).toHaveAttribute('aria-pressed', 'true');
    // Only the row that was asked shows its key
    await expect.element(row('Anthropic').getByLabelText('Anthropic API key', { exact: true })).toHaveAttribute('type', 'password');

    await row('OpenAI').getByRole('button', { name: 'Hide OpenAI key' }).click();
    await expect.element(keyInput).toHaveAttribute('type', 'password');
  });

  test.each([
    ['too short', 'sk-short'],
    ['with a space inside', 'sk-ant-api03 with-a-space'],
  ])('checks the format of a key that is %s before it asks the server', async (_, key) => {
    const { requests } = answerAccount();

    await renderSection();
    const keyInput = row('Anthropic').getByLabelText('Anthropic API key', { exact: true });
    await keyInput.fill(key);
    await row('Anthropic').getByRole('button', { name: 'Register Anthropic key' }).click();

    await expect.element(row('Anthropic').getByRole('alert')).toHaveTextContent('A key must be 16 to 512 printable characters without spaces.');
    expect(requests.filter(({ method }) => method === 'PUT')).toHaveLength(0);
    // A key that was refused here never left the page, so it stays where it was typed
    await expect.element(keyInput).toHaveValue(key);
    // Typing again clears the error
    await keyInput.fill(`${key}x`);
    await expect.element(row('Anthropic').getByRole('alert')).not.toBeInTheDocument();
  });

  test('drops the spaces and line breaks around a pasted key', async () => {
    const { requests } = answerAccount();

    await renderSection();
    await row('Google').getByLabelText('Google API key', { exact: true }).fill(`  ${GOOGLE_KEY}\n`);
    await row('Google').getByRole('button', { name: 'Register Google key' }).click();

    await expect.element(page.getByText('The Google key has been registered.')).toBeVisible();
    expect(requests.filter(({ method }) => method === 'PUT')).toEqual([{ method: 'PUT', provider: 'google', body: { key: GOOGLE_KEY } }]);
  });

  test.each([
    [400, 'invalid_key', 'The provider did not accept this key'],
    [503, 'validation_unavailable', 'The provider could not be reached to check the key. Try again later'],
    [503, 'service_unavailable', 'Provider keys are not available right now'],
  ])('shows a %i %s on the row, and the input stays cleared', async (statusCode, error, description) => {
    answerAccount();
    answerPutError('openai', statusCode, error, description);

    await renderSection();
    const keyInput = row('OpenAI').getByLabelText('OpenAI API key', { exact: true });
    await keyInput.fill('sk-proj-test-key-0002-abcd');
    await row('OpenAI').getByRole('button', { name: 'Register OpenAI key' }).click();

    await expect.element(row('OpenAI').getByRole('alert')).toHaveTextContent(description);
    await expect.element(keyInput).toHaveValue('');
    await expect.element(row('OpenAI')).toHaveTextContent('Not set');
    // The error belongs to its own row
    expect(row('Anthropic').getByRole('alert').query()).toBeNull();
    expect(document.body.textContent).not.toContain('sk-proj-test-key-0002-abcd');
  });
});

describe('ProviderKeysSection — remove', () => {
  test('asks for confirmation, and Cancel removes nothing', async () => {
    const { requests } = answerAccount({ anthropic: '1234' });

    await renderSection();
    await row('Anthropic').getByRole('button', { name: 'Remove Anthropic key' }).click();

    await expect.element(page.getByRole('alertdialog')).toHaveTextContent('Remove the Anthropic key?');

    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(0);
    await expect.element(row('Anthropic')).toHaveTextContent('Configured');
  });

  test('removes the key with DELETE after the confirmation, and the row and the history follow', async () => {
    const { requests } = answerAccount({ anthropic: '1234', google: 'wxyz' });

    await renderSection();
    await row('Anthropic').getByRole('button', { name: 'Remove Anthropic key' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();

    await vi.waitFor(() => {
      expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([{ method: 'DELETE', provider: 'anthropic' }]);
    });
    await expect.element(page.getByText('The Anthropic key has been removed.')).toBeVisible();
    await expect.element(row('Anthropic')).toHaveTextContent('Not set');
    await expect.element(row('Google')).toHaveTextContent('Configured');
    await expect.element(historySection().getByRole('listitem')).toHaveTextContent('Removed');
  });

  test('shows the error of a failed removal on the row', async () => {
    answerAccount({ anthropic: '1234' });
    worker.use(
      http.delete(`${MANAGER_URL}/provider-keys/anthropic`, async () => {
        return HttpResponse.json({ error: 'service_unavailable', error_description: 'Provider keys are not available right now' }, { status: 503 });
      }),
    );

    await renderSection();
    await row('Anthropic').getByRole('button', { name: 'Remove Anthropic key' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();

    await expect.element(row('Anthropic').getByRole('alert')).toHaveTextContent('Provider keys are not available right now');
    await expect.element(row('Anthropic')).toHaveTextContent('Configured');
  });

  test('a key that was already gone shows the 404 and the row reads not set', async () => {
    let listCount = 0;
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys`, async () => {
        listCount += 1;
        // Configured when the page loaded, removed elsewhere in the meantime
        return HttpResponse.json({ data: PROVIDER_NAMES.map((provider) => status(provider, provider === 'xai' && listCount === 1 ? 'abcd' : undefined)) });
      }),
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => HttpResponse.json({ data: [] })),
      http.delete(`${MANAGER_URL}/provider-keys/xai`, async () => {
        return HttpResponse.json({ error: 'not_found', error_description: 'Provider key not found' }, { status: 404 });
      }),
    );

    await renderSection();
    await row('xAI (Grok)').getByRole('button', { name: 'Remove xAI (Grok) key' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();

    await expect.element(row('xAI (Grok)').getByRole('alert')).toHaveTextContent('Provider key not found');
    await expect.element(row('xAI (Grok)')).toHaveTextContent('Not set');
  });
});

describe('ProviderKeyAuditList', () => {
  test('shows the history newest first with the provider, the action and the time', async () => {
    const history: ProviderKeyAuditEvent[] = [
      { provider: 'google', action: 'used', at: '2026-10-26T04:00:00.000Z' },
      { provider: 'openai', action: 'removed', at: '2026-10-26T03:00:00.000Z' },
      { provider: 'google', action: 'replaced', at: '2026-10-26T02:00:00.000Z' },
      { provider: 'xai', action: 'registered', at: '2026-10-26T01:00:00.000Z' },
    ];
    answerAccount({ google: 'wxyz' }, history);

    await renderSection();

    await expect.element(historySection().getByRole('listitem').first()).toBeVisible();
    const items = historySection()
      .getByRole('listitem')
      .elements()
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' '));
    expect(items).toEqual([
      `GoogleUsed${formatDateTime('2026-10-26T04:00:00.000Z')}`,
      `OpenAIRemoved${formatDateTime('2026-10-26T03:00:00.000Z')}`,
      `GoogleReplaced${formatDateTime('2026-10-26T02:00:00.000Z')}`,
      `xAI (Grok)Registered${formatDateTime('2026-10-26T01:00:00.000Z')}`,
    ]);
  });

  test('says that there is no history yet', async () => {
    answerAccount();

    await renderSection();

    await expect.element(historySection()).toHaveTextContent('No provider key history yet.');
  });

  test('shows the error_description of a failed history, and Retry loads it again', async () => {
    let requests = 0;
    answerAccount();
    worker.use(
      http.get(`${MANAGER_URL}/provider-keys/audit`, async () => {
        requests += 1;
        if (requests === 1) {
          return HttpResponse.json({ error: 'service_unavailable', error_description: 'Provider keys are not available right now' }, { status: 503 });
        }
        return HttpResponse.json({ data: [{ provider: 'google', action: 'used', at: '2026-10-26T04:00:00.000Z' }] });
      }),
    );

    await renderSection();

    await expect
      .element(historySection().getByRole('alert'))
      .toHaveTextContent('Failed to load provider key history: Provider keys are not available right now');
    // The keys themselves loaded, so their section has nothing to report
    await expect.element(row('Google')).toBeVisible();

    await page.getByRole('button', { name: 'Retry loading provider key history' }).click();

    await expect.element(historySection().getByRole('listitem')).toHaveTextContent('Used');
  });
});
