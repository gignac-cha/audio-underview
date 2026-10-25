import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { page } from 'vitest/browser';
import { test, expect } from '../../tests/extensions.ts';
import { worker } from '../../tests/mocks/browser.ts';
import { useNewNewscast } from '../../hooks/use-new-newscast.ts';
import type { ProviderName } from '../../schemas/provider-keys.ts';
import { NewNewscastPanel } from './NewNewscastPanel.tsx';
import {
  EARLIER_RUN_ID,
  EARLIER_STAGE_RUN_ID,
  FORM_STAGE_RUN_ID,
  NEWSCAST_STAGE_ID,
  NEWSCAST_WORKER_URL,
  RUN_ID,
  SCHEDULER_ID,
  SCHEDULER_MANAGER_URL,
  TEXT_FORM,
  URL_FORM,
  fakeNewscastScheduler,
  geekNewsForm,
  type RecordedRequest,
} from './tests/newscast-scheduler-fake.ts';

const CRAWLER_MANAGER_URL = 'http://localhost:8888';
const FORM_PATH = `/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${FORM_STAGE_RUN_ID}`;

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

function answerProviderKeys(configured: ProviderName[]) {
  worker.use(
    http.get(`${CRAWLER_MANAGER_URL}/provider-keys`, () =>
      HttpResponse.json({
        data: (['anthropic', 'openai', 'google', 'xai'] as const).map((provider) => ({
          provider,
          configured: configured.includes(provider),
          last4: configured.includes(provider) ? 'abcd' : null,
          validated_at: null,
        })),
      }),
    ),
  );
}

function Harness() {
  const newNewscast = useNewNewscast({ pollIntervalMilliseconds: 20 });
  return <NewNewscastPanel newNewscast={newNewscast} />;
}

async function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return await render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/newscasts']}>
        <Routes>
          <Route path="/newscasts" element={<Harness />} />
          <Route path="/settings" element={<div>Settings screen</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function settingsOf(requests: RecordedRequest[]) {
  const put = requests.find((request) => request.method === 'PUT');
  return (put?.body as { settings?: Record<string, unknown> } | undefined)?.settings;
}

function answerOf(requests: RecordedRequest[]) {
  const answer = requests.find((request) => request.path === `${FORM_PATH}/answer`);
  return (answer?.body as { answer?: unknown } | undefined)?.answer;
}

const sourceTab = (name: string) => page.getByRole('tab', { name });
// A select's accessible name is its label followed by the picked option
const select = (label: string) => page.getByRole('combobox', { name: new RegExp(`^${label}`) });
const startButton = () => page.getByRole('button', { name: /^(Pick GeekNews articles|Make newscast)$/ });

beforeEach(() => {
  vi.stubEnv('VITE_NEWSCAST_WORKER_URL', NEWSCAST_WORKER_URL);
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('NewNewscastPanel — keys', () => {
  test('blocks the start without a Google key and points to Settings', async () => {
    answerProviderKeys([]);
    await renderPanel();

    await expect.element(page.getByRole('alert').getByText(/voiced with your Google key/)).toBeInTheDocument();
    await expect.element(startButton()).toBeDisabled();

    await page.getByRole('button', { name: 'Go to Settings' }).click();

    await expect.element(page.getByText('Settings screen')).toBeInTheDocument();
  });

  test('points out a missing key of the picked provider without blocking the start', async () => {
    answerProviderKeys(['google']);
    await renderPanel();
    await expect.element(startButton()).toBeEnabled();

    await select('Provider').selectOptions('anthropic');

    await expect.element(page.getByText(/The script is written with your Anthropic key, which is not registered/)).toBeInTheDocument();
    await expect.element(startButton()).toBeEnabled();
  });
});

describe('NewNewscastPanel — settings', () => {
  test('stores the picked settings on the newscast stage', async () => {
    answerProviderKeys(['google', 'anthropic']);
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(2) });
    await renderPanel();

    await select('Provider').selectOptions('anthropic');
    // A new provider starts on its default model
    await expect.element(select('Model')).toHaveValue('claude-opus-5-5');
    await select('Effort').selectOptions('max');
    await select('TTS').selectOptions('gemini-3.8-flash-tts');
    await page.getByRole('button', { name: 'Long' }).click();
    await page.getByRole('checkbox', { name: /^Signal between parts/ }).click();
    await startButton().click();

    await expect.poll(() => settingsOf(requests)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'max',
      length: 'long',
      tts_model: 'gemini-3.8-flash-tts',
      signal: true,
    });
    expect(requests.find((request) => request.method === 'PUT')?.path).toBe(`/schedulers/${SCHEDULER_ID}/stages/${NEWSCAST_STAGE_ID}`);
  });

  test('offers only the efforts of the picked model, and drops one the next model does not take', async () => {
    answerProviderKeys(['google', 'anthropic']);
    await renderPanel();

    await select('Provider').selectOptions('anthropic');
    await select('Effort').selectOptions('max');
    // Haiku 4.5 has no effort control
    await select('Model').selectOptions('claude-haiku-4-5-20251001');

    await expect.element(select('Effort')).toBeDisabled();
    await expect.element(select('Effort')).toHaveValue('');
  });
});

describe('NewNewscastPanel — GeekNews', () => {
  test('shows the choices of the form as text, lets at most 10 be picked and answers their indices', async () => {
    answerProviderKeys(['google']);
    const form = geekNewsForm(12);
    form.fields[0].choices[0].label = '<b>Not bold</b> & not a link';
    // The run keeps running after the answer, so the status that it is being made stays up
    const { requests } = fakeNewscastScheduler({
      source: 'geeknews',
      form,
      readsBeforeForm: 1,
      runningReadsAfterAnswer: Number.POSITIVE_INFINITY,
    });
    await renderPanel();

    await startButton().click();

    const picker = page.getByRole('group', { name: 'GeekNews articles' });
    await expect.element(picker.getByText('<b>Not bold</b> & not a link')).toBeInTheDocument();
    expect(picker.element().querySelector('b')).toBeNull();
    expect(picker.getByRole('link').query()).toBeNull();
    await expect.element(picker.getByText('https://example.com/2')).toBeInTheDocument();

    const checkboxes = picker.getByRole('checkbox');
    for (let index = 0; index < 10; index += 1) {
      await checkboxes.nth(index).click();
    }
    await expect.element(picker.getByText('10 of 12 selected · max 10')).toBeInTheDocument();
    await expect.element(checkboxes.nth(10)).toBeDisabled();
    await checkboxes.nth(4).click();

    await page.getByRole('button', { name: 'Make 9 newscasts' }).click();

    await expect.poll(() => answerOf(requests)).toEqual({ articles: [0, 1, 2, 3, 5, 6, 7, 8, 9] });
    await expect.element(page.getByRole('status')).toHaveTextContent('The newscast is being made.');
  });

  test('answers nothing until an article is picked, and cancels the form', async () => {
    answerProviderKeys(['google']);
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(3) });
    await renderPanel();

    await startButton().click();
    await expect.element(page.getByRole('button', { name: 'Make 0 newscasts' })).toBeDisabled();

    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.poll(() => requests.at(-1)).toEqual({ method: 'POST', path: `${FORM_PATH}/cancel` });
    await expect.element(startButton()).toBeEnabled();
    expect(page.getByRole('group', { name: 'GeekNews articles' }).query()).toBeNull();
  });

  test('clears the pick and says the run no longer waits when the form expired before the answer', async () => {
    answerProviderKeys(['google']);
    fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(3), answerStatus: 409 });
    await renderPanel();

    await startButton().click();
    const picker = page.getByRole('group', { name: 'GeekNews articles' });
    await picker.getByRole('checkbox').nth(0).click();
    await page.getByRole('button', { name: 'Make 1 newscast' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('This newscast is no longer waiting for an answer');
    expect(page.getByRole('group', { name: 'GeekNews articles' }).query()).toBeNull();
    await expect.element(startButton()).toBeEnabled();
  });
});

describe('NewNewscastPanel — URL and Text', () => {
  test('answers the URL form with the typed URL', async () => {
    answerProviderKeys(['google']);
    const { requests } = fakeNewscastScheduler({ source: 'url', form: URL_FORM });
    await renderPanel();

    await sourceTab('URL').click();
    await expect.element(startButton()).toBeDisabled();
    await page.getByLabelText('Article URL').fill('ftp://example.com/file');
    await expect.element(page.getByText('Enter an http or https URL.')).toBeInTheDocument();
    await expect.element(startButton()).toBeDisabled();

    await page.getByLabelText('Article URL').fill(' https://example.com/article ');
    await startButton().click();

    await expect.poll(() => answerOf(requests)).toEqual({ url: 'https://example.com/article' });
    expect(requests[0]).toEqual({ method: 'POST', path: '/newscasts/schedulers', body: { source: 'url' } });
    expect(settingsOf(requests)).not.toHaveProperty('verbatim');
  });

  test('answers the Text form with the typed title and text, and stores verbatim', async () => {
    answerProviderKeys(['google']);
    const { requests } = fakeNewscastScheduler({ source: 'text', form: TEXT_FORM });
    await renderPanel();

    await sourceTab('Text').click();
    await page.getByLabelText('Title (optional)').fill('My title');
    await page.getByLabelText('Text', { exact: true }).fill('Speaker1: Hello\nSpeaker2: Hi');
    await expect.element(page.getByText('28 / 24,000')).toBeInTheDocument();
    await page.getByRole('checkbox', { name: /^Read verbatim/ }).click();
    await startButton().click();

    await expect.poll(() => answerOf(requests)).toEqual({ text: 'Speaker1: Hello\nSpeaker2: Hi', title: 'My title' });
    expect(settingsOf(requests)).toMatchObject({ verbatim: true });
  });

  test('leaves the title out when none was typed', async () => {
    answerProviderKeys(['google']);
    const { requests } = fakeNewscastScheduler({ source: 'text', form: TEXT_FORM });
    await renderPanel();

    await sourceTab('Text').click();
    await page.getByLabelText('Text', { exact: true }).fill('An article body');
    await startButton().click();

    await expect.poll(() => answerOf(requests)).toEqual({ text: 'An article body' });
  });
});

describe('NewNewscastPanel — a run already in progress', () => {
  test('says so and cancels the waiting form', async () => {
    answerProviderKeys(['google']);
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(1), executeStatus: 409 });
    await renderPanel();

    await startButton().click();

    await expect.element(page.getByText(/A newscast from this source is waiting for an answer/)).toBeInTheDocument();
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect.poll(() => requests.at(-1)).toEqual({
      method: 'POST',
      path: `/schedulers/${SCHEDULER_ID}/runs/${EARLIER_RUN_ID}/stage-runs/${EARLIER_STAGE_RUN_ID}/cancel`,
    });
    await expect.element(page.getByText(/A newscast from this source is waiting for an answer/)).not.toBeInTheDocument();
  });

  test('offers no Cancel when the run in progress waits on no form', async () => {
    answerProviderKeys(['google']);
    fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(1), executeStatus: 409, earlierRunWaits: false });
    await renderPanel();

    await startButton().click();

    await expect.element(page.getByText(/A newscast from this source is still in progress/)).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Cancel' }).query()).toBeNull();

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(page.getByText(/still in progress/)).not.toBeInTheDocument();
  });
});
