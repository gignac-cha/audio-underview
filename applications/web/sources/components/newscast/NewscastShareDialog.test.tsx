import { cleanup, render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import { AuthenticationContext, type AuthenticationContextValue } from '../../contexts/authentication-context-value.ts';
import type { ShareState } from '../../hooks/use-newscast-share.ts';
import { NewscastShareDialog } from './NewscastShareDialog.tsx';

const NEWSCAST_URL = 'http://localhost:6666';
const SHARE_URL = `${NEWSCAST_URL}/newscasts/job-1/share`;
const USER = { id: 'u1', name: 'Jin', email: 'user@example.com', provider: 'google' as const };

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(() => ({ user: USER, credential: 'test-access-token', expiresAt: Date.now() + 3_600_000 })),
  };
});

function createAuthentication(): AuthenticationContextValue {
  return {
    user: USER,
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

async function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return await render(
    <AuthenticationContext.Provider value={createAuthentication()}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <NewscastShareDialog jobID="job-1" open={true} onOpenChange={() => undefined} />
        </ToastProvider>
      </QueryClientProvider>
    </AuthenticationContext.Provider>,
  );
}

interface ShareRequest {
  method: string;
  body?: unknown;
}

/** GET answers `state`; PUT and DELETE are recorded and answered like the worker. */
function answerShare(state: ShareState, options: { putStatus?: number; deleteStatus?: number } = {}) {
  const requests: ShareRequest[] = [];
  worker.use(
    http.get(SHARE_URL, () => HttpResponse.json(state)),
    http.put(SHARE_URL, async ({ request }) => {
      const body = (await request.json()) as { regenerate?: boolean };
      requests.push({ method: 'PUT', body });
      if (options.putStatus !== undefined) {
        return HttpResponse.json({ error: 'share_unavailable', error_description: 'The share store is down.' }, { status: options.putStatus });
      }
      return HttpResponse.json({ token: body.regenerate === true ? 'reissued-token' : 'fresh-token' });
    }),
    http.delete(SHARE_URL, () => {
      requests.push({ method: 'DELETE' });
      if (options.deleteStatus !== undefined) {
        return HttpResponse.json({ error: 'job_not_found', error_description: 'Newscast job-1 was not found.' }, { status: options.deleteStatus });
      }
      return HttpResponse.json({ removed: true });
    }),
  );
  return requests;
}

const LINKED_STATE: ShareState = { shared: true, token: 'existing-token', metadata: { showModel: true } };

const toggle = (name: string) => page.getByRole('switch', { name });

beforeEach(() => {
  vi.stubEnv('VITE_NEWSCAST_WORKER_URL', NEWSCAST_URL);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('NewscastShareDialog — no link yet', () => {
  test('starts with every metadata toggle off', async () => {
    answerShare({ shared: false });
    await renderDialog();

    for (const name of ['Show your name', 'Show your email', 'Show the model', 'Show the source links', 'Show the creation date']) {
      await expect.element(toggle(name)).toHaveAttribute('aria-checked', 'false');
    }
  });

  test('previews the CURRENT session name and email next to their toggles', async () => {
    answerShare({ shared: false });
    await renderDialog();

    await expect.element(page.getByText(`Preview: ${USER.name}`)).toBeInTheDocument();
    await expect.element(page.getByText(`Preview: ${USER.email}`)).toBeInTheDocument();
  });

  test('sends nothing until Create link is pressed', async () => {
    const requests = answerShare({ shared: false });
    await renderDialog();

    await toggle('Show the model').click();
    await expect.element(toggle('Show the model')).toHaveAttribute('aria-checked', 'true');
    expect(requests).toEqual([]);

    await page.getByRole('button', { name: 'Create link' }).click();

    await expect.poll(() => requests).toEqual([{ method: 'PUT', body: { metadata: { showModel: true } } }]);
    await expect.element(page.getByRole('textbox', { name: 'Share link' })).toHaveValue('fresh-token');
  });

  test('omits every still-off toggle from the create body, including name and email', async () => {
    const requests = answerShare({ shared: false });
    await renderDialog();

    await page.getByRole('button', { name: 'Create link' }).click();

    await expect.poll(() => requests).toEqual([{ method: 'PUT', body: { metadata: {} } }]);
  });

  test('includes the live session name and email only once toggled on', async () => {
    const requests = answerShare({ shared: false });
    await renderDialog();

    await toggle('Show your name').click();
    await toggle('Show your email').click();
    await page.getByRole('button', { name: 'Create link' }).click();

    await expect.poll(() => requests).toEqual([{ method: 'PUT', body: { metadata: { displayName: USER.name, email: USER.email } } }]);
  });

  test('does not render the link row, copy button, or revoke and reissue actions', async () => {
    answerShare({ shared: false });
    await renderDialog();

    await expect.element(page.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
    expect(page.getByRole('textbox', { name: 'Share link' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Copy' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Revoke link' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Issue a new link' }).query()).toBeNull();
  });
});

describe('NewscastShareDialog — an active link (toggle → immediate PUT)', () => {
  test('reflects the stored metadata as toggle positions on open', async () => {
    answerShare(LINKED_STATE);
    await renderDialog();

    await expect.element(toggle('Show the model')).toHaveAttribute('aria-checked', 'true');
    await expect.element(toggle('Show the source links')).toHaveAttribute('aria-checked', 'false');
    await expect.element(toggle('Show your name')).toHaveAttribute('aria-checked', 'false');
  });

  test('PUTs immediately on toggle, carrying every key that is on', async () => {
    const requests = answerShare(LINKED_STATE);
    await renderDialog();

    await toggle('Show the source links').click();

    await expect.poll(() => requests).toEqual([{ method: 'PUT', body: { metadata: { showModel: true, showSourceLinks: true } } }]);
  });

  test('drops a toggle from the PUT body the instant it is switched off', async () => {
    const requests = answerShare(LINKED_STATE);
    await renderDialog();

    await toggle('Show the model').click();

    await expect.poll(() => requests).toEqual([{ method: 'PUT', body: { metadata: {} } }]);
  });

  test('reverts the toggle and shows an error toast when the PUT fails', async () => {
    answerShare(LINKED_STATE, { putStatus: 500 });
    await renderDialog();

    await toggle('Show the source links').click();

    await expect.element(page.getByText('Could not save the share settings')).toBeInTheDocument();
    await expect.element(page.getByText('The share store is down.')).toBeInTheDocument();
    await expect.element(toggle('Show the source links')).toHaveAttribute('aria-checked', 'false');
  });

  test('shows the full share URL and copies it to the clipboard', async () => {
    vi.stubEnv('VITE_SHARE_VIEWER_URL', 'https://audio-underview-share.pages.dev/');
    answerShare(LINKED_STATE);
    const writeText = vi.fn().mockResolvedValue(undefined);
    // `navigator.clipboard` is a read-only accessor inherited from the Navigator prototype; shadow
    // it with an own, configurable property instead of assigning through it
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderDialog();

    const expectedURL = 'https://audio-underview-share.pages.dev/share/existing-token';
    await expect.element(page.getByRole('textbox', { name: 'Share link' })).toHaveValue(expectedURL);

    await page.getByRole('button', { name: 'Copy' }).click();

    expect(writeText).toHaveBeenCalledWith(expectedURL);
    await expect.element(page.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  test('falls back to the bare token when the viewer URL is not configured', async () => {
    answerShare(LINKED_STATE);
    await renderDialog();

    await expect.element(page.getByRole('textbox', { name: 'Share link' })).toHaveValue('existing-token');
    await expect.element(page.getByText(/VITE_SHARE_VIEWER_URL is not set/)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });

  test('revokes the link with Revoke link', async () => {
    const requests = answerShare(LINKED_STATE);
    await renderDialog();

    await page.getByRole('button', { name: 'Revoke link' }).click();

    await expect.poll(() => requests).toEqual([{ method: 'DELETE' }]);
    await expect.element(page.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  });

  test('reports a revoke failure without pretending it succeeded', async () => {
    answerShare(LINKED_STATE, { deleteStatus: 404 });
    await renderDialog();

    await page.getByRole('button', { name: 'Revoke link' }).click();

    await expect.element(page.getByText('Could not revoke the share link')).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Revoke link' })).toBeInTheDocument();
  });

  test('reissues the token only after confirming the warning', async () => {
    const requests = answerShare(LINKED_STATE);
    await renderDialog();

    await page.getByRole('button', { name: 'Issue a new link' }).click();
    await expect.element(page.getByText(/The current share link stops working at once/)).toBeInTheDocument();
    expect(requests).toEqual([]);

    await page.getByRole('button', { name: 'Issue', exact: true }).click();

    await expect.poll(() => requests).toEqual([{ method: 'PUT', body: { metadata: { showModel: true }, regenerate: true } }]);
    await expect.element(page.getByRole('textbox', { name: 'Share link' })).toHaveValue('reissued-token');
  });

  test('keeps the existing link when the reissue confirmation is cancelled', async () => {
    const requests = answerShare(LINKED_STATE);
    await renderDialog();

    await page.getByRole('button', { name: 'Issue a new link' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(requests).toEqual([]);
  });
});

describe('NewscastShareDialog — loading and error states', () => {
  test('shows a loading note while the GET is on its way', async () => {
    // Held until the test has looked, then answered, so no request is left open behind the test
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    worker.use(
      http.get(SHARE_URL, async () => {
        await held;
        return HttpResponse.json({ shared: false });
      }),
    );
    await renderDialog();

    await expect.element(page.getByText('Loading…')).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Create link' }).query()).toBeNull();

    release();
    await expect.element(page.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
  });

  test('shows the GET error instead of the toggle list', async () => {
    worker.use(
      http.get(SHARE_URL, () => HttpResponse.json({ error: 'job_not_found', error_description: 'Newscast job-1 was not found.' }, { status: 404 })),
    );
    await renderDialog();

    await expect.element(page.getByRole('alert')).toHaveTextContent('Newscast job-1 was not found.');
    expect(page.getByRole('button', { name: 'Create link' }).query()).toBeNull();
  });
});
