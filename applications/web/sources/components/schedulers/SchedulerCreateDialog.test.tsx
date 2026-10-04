import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import { SchedulerCreateDialog } from './SchedulerCreateDialog.tsx';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';

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

// Pretends the browser runs in `timezone` without touching how dates are formatted.
function stubBrowserTimezone(timezone: string) {
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolvedOptions.call(this), timeZone: timezone };
  });
}

function renderDialog(onOpenChange: (open: boolean) => void = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <SchedulerCreateDialog open onOpenChange={onOpenChange} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function hintFor(timezone: string) {
  return page.getByText(`Runs at minute 0, 10, 20, 30, 40 or 50 · ${timezone} time`, { exact: true });
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('SchedulerCreateDialog timezone', () => {
  test('defaults to the browser zone and names it in the hint', async () => {
    stubBrowserTimezone('America/New_York');
    await renderDialog();

    await expect.element(page.getByLabelText('Timezone')).toHaveValue('America/New_York');
    await expect.element(hintFor('America/New_York')).toBeVisible();
  });

  test('defaults to UTC when the browser zone is off the 10-minute grid', async () => {
    stubBrowserTimezone('Asia/Kathmandu');
    await renderDialog();

    await expect.element(page.getByLabelText('Timezone')).toHaveValue('UTC');
    await expect.element(hintFor('UTC')).toBeVisible();
  });

  test('does not offer zones off the 10-minute grid', async () => {
    stubBrowserTimezone('Asia/Seoul');
    await renderDialog();

    const select = page.getByLabelText('Timezone');
    await expect.element(select.getByRole('option', { name: 'Asia/Seoul', exact: true })).toBeInTheDocument();
    await expect.element(select.getByRole('option', { name: 'UTC', exact: true })).toBeInTheDocument();
    // The browser lists Kathmandu under its older name.
    await expect.element(select.getByRole('option', { name: 'Asia/Katmandu', exact: true })).not.toBeInTheDocument();
    await expect.element(select.getByRole('option', { name: 'Pacific/Chatham', exact: true })).not.toBeInTheDocument();
    await expect.element(select.getByRole('option', { name: 'Australia/Eucla', exact: true })).not.toBeInTheDocument();
  });

  test('the hint follows the chosen zone', async () => {
    stubBrowserTimezone('America/New_York');
    await renderDialog();

    await page.getByLabelText('Timezone').selectOptions('Asia/Seoul');

    await expect.element(hintFor('Asia/Seoul')).toBeVisible();
    await expect.element(hintFor('America/New_York')).not.toBeInTheDocument();
  });

  test('the create request sends the chosen zone', async () => {
    stubBrowserTimezone('America/New_York');
    let requestBody: unknown;
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers`, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 's1', name: 'Morning' }, { status: 201 });
      }),
    );
    await renderDialog();

    await page.getByLabelText('Name').fill('Morning');
    await page.getByLabelText('Cron Expression (optional)').fill('0 9 * * *');
    await page.getByLabelText('Timezone').selectOptions('Asia/Seoul');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect.poll(() => requestBody).toEqual({
      name: 'Morning',
      cron_expression: '0 9 * * *',
      timezone: 'Asia/Seoul',
      is_enabled: true,
    });
  });

  test('the create request sends the default zone when none is chosen', async () => {
    stubBrowserTimezone('America/New_York');
    let requestBody: unknown;
    worker.use(
      http.post(`${SCHEDULER_MANAGER_URL}/schedulers`, async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ id: 's1', name: 'Morning' }, { status: 201 });
      }),
    );
    await renderDialog();

    await page.getByLabelText('Name').fill('Morning');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect.poll(() => requestBody).toEqual({
      name: 'Morning',
      timezone: 'America/New_York',
      is_enabled: true,
    });
  });

  test('closing the dialog resets the zone to the default', async () => {
    stubBrowserTimezone('America/New_York');
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    const select = page.getByLabelText('Timezone');
    await select.selectOptions('Asia/Seoul');
    await expect.element(select).toHaveValue('Asia/Seoul');

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await expect.element(select).toHaveValue('America/New_York');
  });
});
