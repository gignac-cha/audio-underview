import { renderHook } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { test, expect } from '../tests/extensions.ts';
import {
  EARLIER_RUN_ID,
  EARLIER_STAGE_RUN_ID,
  FORM_STAGE_RUN_ID,
  NEWSCAST_STAGE_ID,
  NEWSCAST_WORKER_URL,
  RUN_ID,
  SCHEDULER_ID,
  SCHEDULER_MANAGER_URL,
  URL_FORM,
  fakeNewscastScheduler,
  geekNewsForm,
} from '../components/newscast/tests/newscast-scheduler-fake.ts';
import { useNewNewscast } from './use-new-newscast.ts';

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

const POLL_INTERVAL_MILLISECONDS = 20;
const SETTINGS = { provider: 'google', model: 'gemini-3.8-flash', effort: '', length: 'standard', tts_model: 'gemini-2.5-flash-preview-tts', signal: false };
const RUN_PATH = `/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}`;
const FORM_PATH = `${RUN_PATH}/stage-runs/${FORM_STAGE_RUN_ID}`;
const NOT_WAITING_NOTICE =
  'This newscast is no longer waiting for an answer: its form expired or was closed elsewhere. Start it again.';

async function renderNewNewscast() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = await renderHook(() => useNewNewscast({ pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS }), { wrapper });
  return result;
}

beforeEach(() => {
  vi.stubEnv('VITE_NEWSCAST_WORKER_URL', NEWSCAST_WORKER_URL);
  vi.stubEnv('VITE_SCHEDULER_MANAGER_WORKER_URL', SCHEDULER_MANAGER_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useNewNewscast — GeekNews', () => {
  test('starts the template run, waits for the form and answers the picked choices by their indices', async () => {
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(5), readsBeforeForm: 2 });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'geeknews', settings: SETTINGS });

    await vi.waitFor(() => expect(result.current.step.kind).toBe('choosing'));
    const step = result.current.step;
    expect(step.kind === 'choosing' && step.openForm.form.fields[0]?.choices).toHaveLength(5);
    expect(requests.slice(0, 3)).toEqual([
      { method: 'POST', path: '/newscasts/schedulers', body: { source: 'geeknews' } },
      { method: 'PUT', path: `/schedulers/${SCHEDULER_ID}/stages/${NEWSCAST_STAGE_ID}`, body: { settings: SETTINGS } },
      { method: 'POST', path: `/schedulers/${SCHEDULER_ID}/execute` },
    ]);
    // The run is read until its form stage run waits, then the stage run for its form
    expect(requests.filter((request) => request.path === RUN_PATH)).toHaveLength(3);
    expect(requests.at(-1)).toEqual({ method: 'GET', path: FORM_PATH });

    await result.current.answerChoices([0, 3]);

    expect(requests).toContainEqual({ method: 'POST', path: `${FORM_PATH}/answer`, body: { answer: { articles: [0, 3] } } });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('idle'));
    expect(result.current.error).toBeUndefined();
  });

  test('cancels the open form', async () => {
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(3) });
    const result = await renderNewNewscast();
    await result.current.start({ source: 'geeknews', settings: SETTINGS });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('choosing'));

    const cancelled = await result.current.cancel();

    expect(cancelled).toBe(true);
    expect(requests.at(-1)).toEqual({ method: 'POST', path: `${FORM_PATH}/cancel` });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('idle'));
  });

  test('closes the pick with a notice when the form stopped waiting before the answer reached it', async () => {
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(3), answerStatus: 409 });
    const result = await renderNewNewscast();
    await result.current.start({ source: 'geeknews', settings: SETTINGS });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('choosing'));

    await result.current.answerChoices([1]);

    await vi.waitFor(() => expect(result.current.step).toEqual({ kind: 'idle' }));
    expect(result.current.error).toBe(NOT_WAITING_NOTICE);
    expect(requests.at(-1)).toEqual({ method: 'POST', path: `${FORM_PATH}/answer`, body: { answer: { articles: [1] } } });
  });

  test('closes the pick with a notice when the form stopped waiting before the cancel reached it', async () => {
    fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(3), cancelStatus: 409 });
    const result = await renderNewNewscast();
    await result.current.start({ source: 'geeknews', settings: SETTINGS });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('choosing'));

    const cancelled = await result.current.cancel();

    expect(cancelled).toBe(false);
    await vi.waitFor(() => expect(result.current.step).toEqual({ kind: 'idle' }));
    expect(result.current.error).toBe(NOT_WAITING_NOTICE);
  });

  test('can start again after the form stopped waiting', async () => {
    fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(3), answerStatus: 409 });
    const result = await renderNewNewscast();
    await result.current.start({ source: 'geeknews', settings: SETTINGS });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('choosing'));
    await result.current.answerChoices([0]);
    await vi.waitFor(() => expect(result.current.step.kind).toBe('idle'));

    await result.current.start({ source: 'geeknews', settings: SETTINGS });

    await vi.waitFor(() => expect(result.current.step.kind).toBe('choosing'));
    expect(result.current.error).toBeUndefined();
  });
});

describe('useNewNewscast — URL and Text', () => {
  test('answers the form with what was typed as soon as it opens, then follows the run until it ends', async () => {
    const { requests } = fakeNewscastScheduler({ source: 'url', form: URL_FORM, readsBeforeForm: 1 });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'url', settings: SETTINGS, answer: { url: 'https://example.com/article' } });

    await vi.waitFor(() => expect(result.current.step.kind).toBe('making'));
    expect(requests).toContainEqual({ method: 'POST', path: `${FORM_PATH}/answer`, body: { answer: { url: 'https://example.com/article' } } });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('idle'));
    expect(result.current.error).toBeUndefined();
  });

  test('keeps a refused answer cancellable', async () => {
    const { requests } = fakeNewscastScheduler({ source: 'url', form: URL_FORM, answerStatus: 400 });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'url', settings: SETTINGS, answer: { url: 'https://example.com/article' } });

    await vi.waitFor(() => expect(result.current.error).toBe("Field 'url' must be an http or https URL"));
    expect(result.current.step).toMatchObject({
      kind: 'busy',
      waitingForm: { schedulerID: SCHEDULER_ID, runID: RUN_ID, stageRunID: FORM_STAGE_RUN_ID },
      isCancelling: false,
    });

    await result.current.cancel();

    expect(requests.at(-1)).toEqual({ method: 'POST', path: `${FORM_PATH}/cancel` });
  });

  test('goes back to idle with a notice, offering no cancel, when the form stopped waiting before the answer', async () => {
    fakeNewscastScheduler({ source: 'url', form: URL_FORM, answerStatus: 409 });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'url', settings: SETTINGS, answer: { url: 'https://example.com/article' } });

    await vi.waitFor(() => expect(result.current.error).toBe(NOT_WAITING_NOTICE));
    expect(result.current.step).toEqual({ kind: 'idle' });
    expect(await result.current.cancel()).toBe(false);
  });

  test('reports the error of a run that fails after the answer', async () => {
    fakeNewscastScheduler({
      source: 'text',
      form: URL_FORM,
      endAfterAnswer: { status: 'failed', error: 'Stage 2: All 1 newscasts failed: no Google key' },
    });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'text', settings: SETTINGS, answer: { text: 'Body' } });

    await vi.waitFor(() => expect(result.current.error).toBe('Stage 2: All 1 newscasts failed: no Google key'));
    expect(result.current.step.kind).toBe('idle');
  });

  test('reports the error of a run that ends before its form opens', async () => {
    fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(1), failBeforeForm: 'Stage 1: the crawler failed' });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'geeknews', settings: SETTINGS });

    await vi.waitFor(() => expect(result.current.error).toBe('Stage 1: the crawler failed'));
    expect(result.current.step.kind).toBe('idle');
  });
});

describe('useNewNewscast — a run already in progress', () => {
  test('finds the form the run in progress waits on, and cancels it', async () => {
    const { requests } = fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(1), executeStatus: 409 });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'geeknews', settings: SETTINGS });

    await vi.waitFor(() => expect(result.current.step.kind).toBe('busy'));
    expect(result.current.step).toEqual({
      kind: 'busy',
      waitingForm: { schedulerID: SCHEDULER_ID, runID: EARLIER_RUN_ID, stageRunID: EARLIER_STAGE_RUN_ID },
      isCancelling: false,
    });
    expect(result.current.error).toBeUndefined();

    const cancelled = await result.current.cancel();

    expect(cancelled).toBe(true);
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      path: `/schedulers/${SCHEDULER_ID}/runs/${EARLIER_RUN_ID}/stage-runs/${EARLIER_STAGE_RUN_ID}/cancel`,
    });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('idle'));
  });

  test('closes the notice when the form of the run in progress stopped waiting before the cancel', async () => {
    fakeNewscastScheduler({ source: 'geeknews', form: geekNewsForm(1), executeStatus: 409, cancelStatus: 409 });
    const result = await renderNewNewscast();
    await result.current.start({ source: 'geeknews', settings: SETTINGS });
    await vi.waitFor(() => expect(result.current.step.kind).toBe('busy'));

    const cancelled = await result.current.cancel();

    expect(cancelled).toBe(false);
    await vi.waitFor(() => expect(result.current.step).toEqual({ kind: 'idle' }));
    expect(result.current.error).toBe(NOT_WAITING_NOTICE);
  });

  test('offers nothing to cancel when the run in progress waits on no form', async () => {
    fakeNewscastScheduler({ source: 'url', form: URL_FORM, executeStatus: 409, earlierRunWaits: false });
    const result = await renderNewNewscast();

    await result.current.start({ source: 'url', settings: SETTINGS, answer: { url: 'https://example.com/article' } });

    await vi.waitFor(() => expect(result.current.step.kind).toBe('busy'));
    expect(result.current.step).toEqual({ kind: 'busy', waitingForm: undefined, isCancelling: false });
    expect(await result.current.cancel()).toBe(false);
  });
});
