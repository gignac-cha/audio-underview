import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page, userEvent } from 'vitest/browser';
import type { SchedulerRow } from '@audio-underview/supabase-connector';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import { SchedulerInfoSection } from './SchedulerInfoSection.tsx';
import { formatInTimezone } from './schedule-timezone.ts';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const NEXT_RUN_AT = '2026-10-06T00:00:00.000Z';

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

function createScheduler(overrides: Partial<SchedulerRow> = {}): SchedulerRow {
  return {
    id: 's1',
    user_uuid: 'u1',
    name: 'Morning Pipeline',
    cron_expression: '0 9 * * *',
    is_enabled: true,
    last_run_at: null,
    timezone: 'Asia/Seoul',
    next_run_at: NEXT_RUN_AT,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderSection(scheduler: SchedulerRow) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SchedulerInfoSection scheduler={scheduler} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('SchedulerInfoSection next run', () => {
  test('shows the time in the schedule zone with its name, and the viewer time when the zones differ', async () => {
    stubBrowserTimezone('America/New_York');
    await renderSection(createScheduler());

    await expect.element(
      page.getByText(`${formatInTimezone(NEXT_RUN_AT, 'Asia/Seoul')} Asia/Seoul`, { exact: true }),
    ).toBeVisible();
    await expect.element(
      page.getByText(`${formatInTimezone(NEXT_RUN_AT, 'America/New_York')} your time`, { exact: true }),
    ).toBeVisible();
  });

  test('shows no viewer time when the browser runs in the schedule zone', async () => {
    stubBrowserTimezone('Asia/Seoul');
    await renderSection(createScheduler());

    await expect.element(
      page.getByText(`${formatInTimezone(NEXT_RUN_AT, 'Asia/Seoul')} Asia/Seoul`, { exact: true }),
    ).toBeVisible();
    await expect.element(page.getByText('your time')).not.toBeInTheDocument();
  });

  test('shows Not scheduled when there is no next run', async () => {
    stubBrowserTimezone('America/New_York');
    await renderSection(createScheduler({ next_run_at: null }));

    await expect.element(page.getByText('Not scheduled', { exact: true })).toBeVisible();
    await expect.element(page.getByText('your time')).not.toBeInTheDocument();
  });
});

describe('SchedulerInfoSection timezone', () => {
  // Records the body of every PUT the section sends for the scheduler.
  function recordUpdateRequests(): unknown[] {
    const requestBodies: unknown[] = [];
    worker.use(
      http.put(`${SCHEDULER_MANAGER_URL}/schedulers/s1`, async ({ request }) => {
        requestBodies.push(await request.json());
        return HttpResponse.json(createScheduler());
      }),
    );
    return requestBodies;
  }

  // Sends one more PUT by switching the scheduler off and waits until it arrives,
  // so every PUT sent before it has arrived as well.
  async function waitForLaterUpdate(requestBodies: unknown[]) {
    await page.getByRole('switch', { name: 'Enable scheduler' }).click();
    await expect.poll(() => requestBodies).toContainEqual({ is_enabled: false });
  }

  const editButton = () => page.getByRole('button', { name: 'Edit timezone, Asia/Seoul', exact: true });
  const zoneList = () => page.getByRole('combobox', { name: 'Timezone', exact: true });

  test('shows the schedule zone', async () => {
    await renderSection(createScheduler());

    await expect.element(editButton()).toHaveTextContent('Asia/Seoul');
  });

  test('does not offer zones off the 10-minute grid', async () => {
    await renderSection(createScheduler());

    await editButton().click();
    const select = zoneList();
    await expect.element(select).toHaveValue('Asia/Seoul');
    await expect.element(select.getByRole('option', { name: 'UTC', exact: true })).toBeInTheDocument();
    // The browser lists Kathmandu under its older name.
    await expect.element(select.getByRole('option', { name: 'Asia/Katmandu', exact: true })).not.toBeInTheDocument();
    await expect.element(select.getByRole('option', { name: 'Pacific/Chatham', exact: true })).not.toBeInTheDocument();
    await expect.element(select.getByRole('option', { name: 'Australia/Eucla', exact: true })).not.toBeInTheDocument();
  });

  test('choosing zones keeps the list open and sends nothing', async () => {
    const requestBodies = recordUpdateRequests();
    await renderSection(createScheduler());

    await editButton().click();
    const select = zoneList();
    await select.selectOptions('UTC');
    await select.selectOptions('America/New_York');

    await expect.element(select).toHaveValue('America/New_York');
    await expect.element(select).toHaveFocus();
    expect(requestBodies).toEqual([]);
  });

  test('Enter saves the chosen zone with PUT { timezone }', async () => {
    const requestBodies = recordUpdateRequests();
    await renderSection(createScheduler());

    await editButton().click();
    const select = zoneList();
    await select.selectOptions('UTC');
    await userEvent.keyboard('{Enter}');

    await expect.element(select).not.toBeInTheDocument();
    await waitForLaterUpdate(requestBodies);
    expect(requestBodies).toEqual([{ timezone: 'UTC' }, { is_enabled: false }]);
  });

  test('leaving the list saves the chosen zone with PUT { timezone }', async () => {
    const requestBodies = recordUpdateRequests();
    await renderSection(createScheduler());

    await editButton().click();
    const select = zoneList();
    await select.selectOptions('UTC');
    await userEvent.tab();

    await expect.element(select).not.toBeInTheDocument();
    await waitForLaterUpdate(requestBodies);
    expect(requestBodies).toEqual([{ timezone: 'UTC' }, { is_enabled: false }]);
  });

  test('Escape closes the list without saving and shows the stored zone again', async () => {
    const requestBodies = recordUpdateRequests();
    await renderSection(createScheduler());

    await editButton().click();
    const select = zoneList();
    await expect.element(select).toHaveFocus();
    await select.selectOptions('UTC');
    await userEvent.keyboard('{Escape}');

    await expect.element(select).not.toBeInTheDocument();
    await expect.element(editButton()).toHaveTextContent('Asia/Seoul');
    await waitForLaterUpdate(requestBodies);
    expect(requestBodies).toEqual([{ is_enabled: false }]);

    await editButton().click();
    await expect.element(zoneList()).toHaveValue('Asia/Seoul');
  });

  test('choosing the stored zone again sends nothing', async () => {
    const requestBodies = recordUpdateRequests();
    await renderSection(createScheduler());

    await editButton().click();
    const select = zoneList();
    await select.selectOptions('UTC');
    await select.selectOptions('Asia/Seoul');
    await userEvent.keyboard('{Enter}');

    await expect.element(select).not.toBeInTheDocument();
    await waitForLaterUpdate(requestBodies);
    expect(requestBodies).toEqual([{ is_enabled: false }]);
  });

  test('Enter opens the zone list from the keyboard', async () => {
    await renderSection(createScheduler());

    await editButton().element().focus();
    await userEvent.keyboard('{Enter}');

    await expect.element(zoneList()).toBeVisible();
  });
});
