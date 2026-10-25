import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page, userEvent } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import type { StageRunSummary } from '../../hooks/use-scheduler-runs.ts';
import { AnswerFormDialog } from './AnswerFormDialog.tsx';

const SCHEDULER_MANAGER_URL = 'http://localhost:7777';
const STAGE_RUN_URL = `${SCHEDULER_MANAGER_URL}/schedulers/s1/runs/run-1/stage-runs/stage-run-1`;
const EXPIRES_AT = '2026-10-27T09:00:00.000Z';

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

function createStageRun(): StageRunSummary {
  return {
    id: 'stage-run-1',
    run_id: 'run-1',
    stage_id: 'stage-1',
    stage_order: 0,
    status: 'waiting',
    started_at: '2026-10-26T09:00:00.000Z',
    completed_at: null,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
    logs_truncated: false,
    created_at: '2026-10-26T09:00:00.000Z',
  };
}

const ARTICLES_FORM = {
  schema: { type: 'object', properties: {} },
  fields: [
    {
      name: 'articles',
      title: 'Articles',
      description: 'Pick the stories to read out',
      widget: 'checkboxes',
      required: true,
      minItems: 1,
      maxItems: 3,
      choices: [
        { label: 'First story', description: 'https://example.com/first' },
        { label: 'Second story' },
        { label: 'Third story' },
        { label: 'Fourth story' },
      ],
    },
  ],
  expires_at: EXPIRES_AT,
};

const ALL_WIDGETS_FORM = {
  schema: { type: 'object', properties: {} },
  fields: [
    {
      name: 'tone',
      title: 'Tone',
      widget: 'radio',
      required: true,
      choices: [{ label: 'Calm', description: 'Slow and warm' }, { label: 'Bright' }],
    },
    { name: 'voice', title: 'Voice', widget: 'select', required: false, choices: [{ label: 'Alto' }, { label: 'Tenor' }] },
    { name: 'topic', title: 'Topic', description: 'What the episode is about', widget: 'text', required: false, maxLength: 20 },
    { name: 'notes', title: 'Notes', widget: 'textarea', required: false },
    { name: 'length', title: 'Length', widget: 'number', required: false, minimum: 1, maximum: 10 },
    { name: 'loud', title: 'Loud', widget: 'toggle', required: false },
  ],
  expires_at: EXPIRES_AT,
};

interface ServerState {
  answerRequests: unknown[];
  cancelRequests: number;
}

interface ServerOptions {
  form?: unknown;
  stageRunStatus?: number;
  answerResponse?: () => Response;
  cancelResponse?: () => Response;
}

function startServer({ form = ARTICLES_FORM, stageRunStatus = 200, answerResponse, cancelResponse }: ServerOptions = {}): ServerState {
  const state: ServerState = { answerRequests: [], cancelRequests: 0 };
  worker.use(
    http.get(STAGE_RUN_URL, () => {
      if (stageRunStatus !== 200) {
        return HttpResponse.json(
          { error: 'unavailable', error_description: 'Service unavailable' },
          { status: stageRunStatus },
        );
      }
      return HttpResponse.json({ ...createStageRun(), input: {}, output: null, logs: null, form });
    }),
    http.post(`${STAGE_RUN_URL}/answer`, async ({ request }) => {
      state.answerRequests.push(await request.json());
      return answerResponse?.() ?? HttpResponse.json({ status: 'completed' });
    }),
    http.post(`${STAGE_RUN_URL}/cancel`, () => {
      state.cancelRequests += 1;
      return cancelResponse?.() ?? HttpResponse.json({ status: 'failed' });
    }),
  );
  return state;
}

function renderDialog(onOpenChange: (open: boolean) => void = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AnswerFormDialog schedulerID="s1" runID="run-1" stageRun={createStageRun()} onOpenChange={onOpenChange} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { result, invalidate };
}

function sendButton() {
  return page.getByRole('button', { name: 'Send answer' });
}

beforeEach(() => {
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AnswerFormDialog widgets', () => {
  test('asks every widget of the form with its title, description and required mark', async () => {
    startServer({ form: { ...ALL_WIDGETS_FORM, fields: [...ARTICLES_FORM.fields, ...ALL_WIDGETS_FORM.fields] } });
    await renderDialog();

    await expect.element(page.getByRole('dialog')).toBeVisible();
    await expect.element(page.getByText('Pick the stories to read out')).toBeVisible();
    await expect.element(page.getByRole('group', { name: 'Articles (required)' })).toBeVisible();
    await expect.element(page.getByRole('checkbox', { name: /First story/ })).toBeVisible();
    await expect.element(page.getByText('https://example.com/first')).toBeVisible();
    await expect.element(page.getByRole('group', { name: 'Tone (required)' })).toBeVisible();
    await expect.element(page.getByRole('radio', { name: /Calm/ })).toBeVisible();
    await expect.element(page.getByText('Slow and warm')).toBeVisible();
    await expect.element(page.getByLabelText('Voice')).toBeVisible();
    await expect.element(page.getByLabelText('Voice').getByRole('option', { name: 'Tenor' })).toBeInTheDocument();
    await expect.element(page.getByLabelText('Topic')).toHaveAttribute('maxlength', '20');
    await expect.element(page.getByText('What the episode is about')).toBeVisible();
    await expect.element(page.getByLabelText('Notes')).toBeVisible();
    await expect.element(page.getByLabelText('Length')).toHaveAttribute('type', 'number');
    await expect.element(page.getByRole('checkbox', { name: 'Loud' })).toBeVisible();
  });

  test('names a field without a title by its name', async () => {
    startServer({
      form: { ...ALL_WIDGETS_FORM, fields: [{ name: 'url', widget: 'text', required: true }] },
    });
    await renderDialog();

    await expect.element(page.getByLabelText('url (required)')).toBeVisible();
  });

  test('draws the labels and descriptions as text, whatever characters they hold', async () => {
    startServer({
      form: {
        ...ARTICLES_FORM,
        fields: [
          {
            ...ARTICLES_FORM.fields[0],
            title: '<i>Articles</i>',
            choices: [
              { label: '<img src=x onerror="window.pwned = true"> <b>bold</b>', description: '<script>window.pwned = true</script>' },
              { label: 'Second story' },
            ],
          },
        ],
      },
    });
    await renderDialog();

    await expect.element(page.getByRole('checkbox', { name: /<b>bold<\/b>/ })).toBeVisible();
    await expect.element(page.getByText('<script>window.pwned = true</script>')).toBeVisible();
    await expect.element(page.getByText('<i>Articles</i>', { exact: false })).toBeVisible();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('img, b, i, script')).toBeNull();
    expect(Reflect.get(window, 'pwned')).toBeUndefined();
  });

  test('shows when the answer is due', async () => {
    startServer();
    await renderDialog();

    await expect.element(page.getByText(/It fails if nobody answers by /)).toBeVisible();
  });

  test('starts from the defaults of the fields', async () => {
    startServer({
      form: {
        ...ALL_WIDGETS_FORM,
        fields: [
          { ...ARTICLES_FORM.fields[0], default: [1, 2] },
          { ...ALL_WIDGETS_FORM.fields[0], default: 1 },
          { ...ALL_WIDGETS_FORM.fields[2], default: 'Daily' },
          { ...ALL_WIDGETS_FORM.fields[5], default: true },
        ],
      },
    });
    await renderDialog();

    await expect.element(page.getByRole('checkbox', { name: /First story/ })).not.toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: /Second story/ })).toBeChecked();
    await expect.element(page.getByRole('checkbox', { name: /Third story/ })).toBeChecked();
    await expect.element(page.getByRole('radio', { name: /Bright/ })).toBeChecked();
    await expect.element(page.getByLabelText('Topic')).toHaveValue('Daily');
    await expect.element(page.getByRole('checkbox', { name: 'Loud' })).toBeChecked();
  });
});

describe('AnswerFormDialog checkboxes', () => {
  test('counts the checked boxes against the maximum', async () => {
    startServer();
    await renderDialog();

    await expect.element(page.getByText('0 / 3 selected · at least 1')).toBeVisible();

    await page.getByRole('checkbox', { name: /First story/ }).click();
    await page.getByRole('checkbox', { name: /Second story/ }).click();

    await expect.element(page.getByText('2 / 3 selected · at least 1')).toBeVisible();
  });

  test('keeps the unchecked boxes from being checked at the maximum, until one is unchecked', async () => {
    startServer();
    await renderDialog();

    await page.getByRole('checkbox', { name: /First story/ }).click();
    await page.getByRole('checkbox', { name: /Second story/ }).click();
    await page.getByRole('checkbox', { name: /Third story/ }).click();

    await expect.element(page.getByText('3 / 3 selected · at least 1')).toBeVisible();
    await expect.element(page.getByRole('checkbox', { name: /Fourth story/ })).toBeDisabled();
    await expect.element(page.getByRole('checkbox', { name: /First story/ })).toBeEnabled();

    await page.getByRole('checkbox', { name: /First story/ }).click();

    await expect.element(page.getByRole('checkbox', { name: /Fourth story/ })).toBeEnabled();
  });

  test('says only how many are checked when the form has no maximum', async () => {
    startServer({ form: { ...ARTICLES_FORM, fields: [{ ...ARTICLES_FORM.fields[0], maxItems: undefined, minItems: undefined }] } });
    await renderDialog();

    await page.getByRole('checkbox', { name: /First story/ }).click();

    await expect.element(page.getByText('1 selected', { exact: true })).toBeVisible();
  });
});

describe('AnswerFormDialog sending', () => {
  test('keeps Send answer off until the required fields are filled', async () => {
    startServer();
    await renderDialog();

    await expect.element(sendButton()).toBeDisabled();

    await page.getByRole('checkbox', { name: /Second story/ }).click();

    await expect.element(sendButton()).toBeEnabled();
  });

  test('sends the choices by index and closes with a notice', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    const { invalidate } = await renderDialog(onOpenChange);

    await page.getByRole('checkbox', { name: /Third story/ }).click();
    await page.getByRole('checkbox', { name: /First story/ }).click();
    await sendButton().click();

    await expect.poll(() => server.answerRequests).toEqual([{ answer: { articles: [0, 2] } }]);
    await expect.element(page.getByText('Answer sent.')).toBeVisible();
    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers', 's1', 'runs'] });
  });

  test('sends every widget as its type and leaves out the fields left empty', async () => {
    const server = startServer({ form: ALL_WIDGETS_FORM });
    await renderDialog();

    await page.getByRole('radio', { name: /Bright/ }).click();
    await page.getByLabelText('Voice').selectOptions('Tenor');
    await page.getByLabelText('Length').fill('2.5');
    await page.getByRole('checkbox', { name: 'Loud' }).click();
    await sendButton().click();

    // topic and notes were left empty
    await expect.poll(() => server.answerRequests).toEqual([
      { answer: { tone: 1, voice: 1, length: 2.5, loud: true } },
    ]);
  });

  test('sends text as typed', async () => {
    const server = startServer({ form: ALL_WIDGETS_FORM });
    await renderDialog();

    await page.getByRole('radio', { name: /Calm/ }).click();
    await page.getByLabelText('Topic').fill('Morning news');
    await page.getByLabelText('Notes').fill('First line\nSecond line');
    await sendButton().click();

    await expect.poll(() => server.answerRequests).toEqual([
      { answer: { tone: 0, topic: 'Morning news', notes: 'First line\nSecond line', loud: false } },
    ]);
  });

  test('sends with Enter in a text field', async () => {
    const server = startServer({
      form: { ...ALL_WIDGETS_FORM, fields: [{ ...ALL_WIDGETS_FORM.fields[2], required: true }] },
    });
    await renderDialog();

    await page.getByLabelText('Topic (required)').fill('Morning news');
    await page.getByLabelText('Topic (required)').click();
    await userEvent.keyboard('{Enter}');

    await expect.poll(() => server.answerRequests).toEqual([{ answer: { topic: 'Morning news' } }]);
  });

  test('says why a number cannot be sent and keeps Send answer off', async () => {
    startServer({ form: { ...ALL_WIDGETS_FORM, fields: [ALL_WIDGETS_FORM.fields[4]] } });
    await renderDialog();

    await page.getByLabelText('Length').fill('11');

    await expect.element(page.getByText('Enter 10 or less.')).toBeVisible();
    await expect.element(sendButton()).toBeDisabled();

    await page.getByLabelText('Length').fill('10');

    await expect.element(page.getByText('Enter 10 or less.')).not.toBeInTheDocument();
    await expect.element(sendButton()).toBeEnabled();
  });

  test('refuses a fraction for a number the schema of the form makes an integer, as the server does', async () => {
    const server = startServer({
      form: {
        ...ALL_WIDGETS_FORM,
        schema: { type: 'object', properties: { length: { type: 'integer', minimum: 1, maximum: 10 } } },
        fields: [ALL_WIDGETS_FORM.fields[4]],
      },
    });
    await renderDialog();

    await page.getByLabelText('Length').fill('2.5');

    await expect.element(page.getByText('Enter a whole number.')).toBeVisible();
    await expect.element(sendButton()).toBeDisabled();

    await page.getByLabelText('Length').fill('3');
    await expect.element(page.getByText('Enter a whole number.')).not.toBeInTheDocument();
    await sendButton().click();

    await expect.poll(() => server.answerRequests).toEqual([{ answer: { length: 3 } }]);
  });

  test('shows the reason the server refuses the answer and stays open for another try', async () => {
    let refusing = true;
    const server = startServer({
      answerResponse: () => (refusing
        ? HttpResponse.json(
          { error: 'invalid_answer', error_description: '$.articles must have at most 2 items' },
          { status: 400 },
        )
        : HttpResponse.json({ status: 'completed' })),
    });
    const onOpenChange = vi.fn();
    const { invalidate } = await renderDialog(onOpenChange);

    await page.getByRole('checkbox', { name: /First story/ }).click();
    await sendButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('$.articles must have at most 2 items');
    expect(onOpenChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers', 's1', 'runs'] }));
    await expect.element(page.getByRole('checkbox', { name: /First story/ })).toBeChecked();

    refusing = false;
    await sendButton().click();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
    expect(server.answerRequests).toHaveLength(2);
  });

  test('says the stage is not waiting when the server answers 409', async () => {
    startServer({
      answerResponse: () => HttpResponse.json(
        { error: 'not_waiting', error_description: 'This stage is not waiting for an answer' },
        { status: 409 },
      ),
    });
    const { invalidate } = await renderDialog();

    await page.getByRole('checkbox', { name: /First story/ }).click();
    await sendButton().click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('This stage is not waiting for an answer');
    // The rows are read again, which show the stage run as it is now
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers', 's1', 'runs'] }));
  });

  test('holds the dialog and the fields while the answer is on its way', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    startServer();
    worker.use(
      http.post(`${STAGE_RUN_URL}/answer`, async () => {
        await hold;
        return HttpResponse.json({ status: 'completed' });
      }),
    );
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    await page.getByRole('checkbox', { name: /First story/ }).click();
    await sendButton().click();

    await expect.element(page.getByRole('button', { name: 'Sending...' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Close' })).toBeDisabled();
    await expect.element(page.getByRole('checkbox', { name: /First story/ })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();

    release();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
  });
});

describe('AnswerFormDialog cancelling the run', () => {
  test('cancels the run and closes with a notice', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    const { invalidate } = await renderDialog(onOpenChange);

    await expect.element(page.getByRole('checkbox', { name: /First story/ })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel run' }).click();

    await expect.poll(() => server.cancelRequests).toBe(1);
    await expect.element(page.getByText('Run cancelled.')).toBeVisible();
    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(server.answerRequests).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['schedulers', 's1', 'runs'] });
  });

  test('shows the reason the server gives when the stage is not waiting any more', async () => {
    startServer({
      cancelResponse: () => HttpResponse.json(
        { error: 'not_waiting', error_description: 'This stage is not waiting for an answer' },
        { status: 409 },
      ),
    });
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    await page.getByRole('button', { name: 'Cancel run' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('This stage is not waiting for an answer');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('closes without a request through Close', async () => {
    const server = startServer();
    const onOpenChange = vi.fn();
    await renderDialog(onOpenChange);

    await page.getByRole('button', { name: 'Close' }).click();

    await expect.poll(() => onOpenChange.mock.calls).toEqual([[false]]);
    expect(server.cancelRequests).toBe(0);
    expect(server.answerRequests).toEqual([]);
  });
});

describe('AnswerFormDialog without a form to show', () => {
  test('says the form cannot be loaded and still lets the run be cancelled', async () => {
    const server = startServer({ stageRunStatus: 503 });
    await renderDialog();

    await expect.element(page.getByText('Failed to load the form: Service unavailable')).toBeVisible();
    await expect.element(sendButton()).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Cancel run' }).click();

    await expect.poll(() => server.cancelRequests).toBe(1);
  });

  test('says the form cannot be shown when the stage run has none', async () => {
    startServer({ form: null });
    await renderDialog();

    await expect.element(page.getByText('The form of this stage cannot be shown.')).toBeVisible();
    await expect.element(sendButton()).not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Cancel run' })).toBeEnabled();
  });

  test('does not show a form it cannot read in part', async () => {
    startServer({
      form: { ...ARTICLES_FORM, fields: [...ARTICLES_FORM.fields, { name: 'broken', widget: 'carousel', required: false }] },
    });
    await renderDialog();

    await expect.element(page.getByText('The form of this stage cannot be shown.')).toBeVisible();
    await expect.element(page.getByRole('checkbox', { name: /First story/ })).not.toBeInTheDocument();
  });
});
