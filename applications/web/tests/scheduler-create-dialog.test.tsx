import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { SchedulerCreateDialog } from '../sources/features/schedulers/components/SchedulerCreateDialog.tsx';
import { testScheduler, testSession } from './fixtures.ts';
import { server, workerURLs } from './mocks/server.ts';
import { renderComponent } from './test-utils.tsx';

describe('SchedulerCreateDialog', () => {
  it('flags an invalid cron expression and blocks submit', async () => {
    const { user } = renderComponent(
      <SchedulerCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} />,
      { session: testSession() },
    );

    await user.type(screen.getByLabelText('Name'), 'My scheduler');
    await user.type(screen.getByLabelText('Cron expression'), 'not-a-cron');

    expect(screen.getByText(/Invalid cron expression/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('creates a scheduler with a valid cron and reports the new id', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${workerURLs.schedulerManager}/schedulers`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(testScheduler({ id: testScheduler().id, name: 'My scheduler' }));
      }),
    );
    const onCreated = vi.fn();

    const { user } = renderComponent(
      <SchedulerCreateDialog open onClose={vi.fn()} onCreated={onCreated} />,
      { session: testSession() },
    );

    await user.type(screen.getByLabelText('Name'), 'My scheduler');
    await user.type(screen.getByLabelText('Cron expression'), '0 9 * * 1-5');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(testScheduler().id);
    });
    expect(body).toMatchObject({ name: 'My scheduler', cron_expression: '0 9 * * 1-5' });
  });

  it('sends a null cron for manual-only schedulers', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${workerURLs.schedulerManager}/schedulers`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(testScheduler());
      }),
    );

    const { user } = renderComponent(
      <SchedulerCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} />,
      { session: testSession() },
    );

    await user.type(screen.getByLabelText('Name'), 'Manual scheduler');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(body).toMatchObject({ cron_expression: null });
    });
  });
});
