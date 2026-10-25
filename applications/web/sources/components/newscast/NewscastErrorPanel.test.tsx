import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { page } from 'vitest/browser';
import type { JobRequestSnapshot, JobStatus } from '@audio-underview/newscast-core';
import { NewscastErrorPanel } from './NewscastErrorPanel.tsx';

/** The panel's Go to Settings button uses useNavigate, so every render has a router. */
async function renderPanel(status: JobStatus) {
  return await render(
    <MemoryRouter initialEntries={['/newscasts']}>
      <Routes>
        <Route path="/newscasts" element={<NewscastErrorPanel status={status} />} />
        <Route path="/settings" element={<div>Settings screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const REQUEST_SNAPSHOT: JobRequestSnapshot = {
  limit: 1,
  entries: [{ title: 'Article', discussionUrl: 'https://example.com/discussion', originalUrl: 'https://example.com/article' }],
  provider: 'google',
  speaker1Voice: 'Puck',
  speaker2Voice: 'Kore',
};

const FAILED_JOB: JobStatus = {
  id: 'c3f487b3-51d7-44df-b1ac-44bd48647fca',
  stage: 'script',
  stageProgress: 0,
  overallProgress: 0.4,
  status: 'error',
  errorCode: 'pipeline_failed',
  error:
    'generateNewscastScript: failed to parse any script lines from the anthropic/claude-haiku-4-5 ' +
    'response (len=5328) [TRUNCATED: stop_reason=max_tokens — output hit the token cap]. Raw: "..."',
  details: {
    failure: {
      stage: 'script',
      message: 'generateNewscastScript: failed to parse any script lines…',
      stopReason: 'max_tokens',
      at: '2026-07-13T21:47:27.000Z',
    },
    timings: {
      'crawl-list': { startedAt: 1, finishedAt: 840, durationMs: 839 },
      script: { startedAt: 1000 },
    },
    request: REQUEST_SNAPSHOT,
  },
};

const BLOCKED_JOB: JobStatus = {
  ...FAILED_JOB,
  errorCode: 'blocked_no_key',
  error: 'xai: provider rejected the credential (401 unauthorized, request-id req_abc123).',
  details: { ...FAILED_JOB.details, scriptRequest: { provider: 'xai', model: 'grok-4.5' } },
};

describe('NewscastErrorPanel', () => {
  test('shows the failing stage headline and the full error message', async () => {
    await renderPanel(FAILED_JOB);

    await expect.element(page.getByRole('alert').getByText('Failed at Write script')).toBeInTheDocument();
    await expect.element(page.getByText(/failed to parse any script lines from the anthropic/)).toBeInTheDocument();
  });

  test('exposes the persisted failure diagnosis inside Debug details', async () => {
    await renderPanel(FAILED_JOB);

    await page.getByText('Debug details').click();

    await expect.element(page.getByText('max_tokens', { exact: true })).toBeVisible();
    await expect.element(page.getByText(FAILED_JOB.id)).toBeVisible();
    await expect.element(page.getByText('2026-07-13T21:47:27.000Z')).toBeVisible();
    await expect.element(page.getByText('started, unfinished')).toBeVisible();
  });

  test('shows the failed TTS chunk when present', async () => {
    await renderPanel({
      ...FAILED_JOB,
      stage: 'tts',
      error: 'TTS chunk 3/5: Gemini TTS request failed (400)',
      details: {
        failure: { stage: 'tts', message: 'TTS chunk 3/5: Gemini TTS request failed (400)', failedChunk: 2, at: '2026-07-13T21:15:57.000Z' },
      },
    });

    await expect.element(page.getByRole('alert').getByText('Failed at Synthesize speech')).toBeInTheDocument();
    await page.getByText('Debug details').click();
    await expect.element(page.getByText('#3')).toBeVisible();
  });

  test('offers no resume, retry or modify action, even with a request snapshot', async () => {
    await renderPanel(FAILED_JOB);

    expect(page.getByRole('button').query()).toBeNull();
  });
});

describe('NewscastErrorPanel — blocked_no_key', () => {
  test('names the provider whose key is missing or rejected, apart from the raw message', async () => {
    await renderPanel(BLOCKED_JOB);

    await expect
      .element(page.getByText('The xAI (Grok) key is missing or was rejected. Register the key in Settings, then start a new newscast.'))
      .toBeInTheDocument();
    // The raw provider error still renders underneath
    await expect.element(page.getByText(/provider rejected the credential/)).toBeInTheDocument();
  });

  test('goes to Settings from the button', async () => {
    await renderPanel(BLOCKED_JOB);

    await page.getByRole('button', { name: 'Go to Settings' }).click();

    await expect.element(page.getByText('Settings screen')).toBeInTheDocument();
  });

  test('falls back to provider-less guidance when no request field carries the provider', async () => {
    await renderPanel({ ...FAILED_JOB, errorCode: 'blocked_no_key', details: undefined });

    await expect.element(page.getByText(/^A provider key is missing or was rejected\./)).toBeInTheDocument();
  });

  test('omits the guidance for an ordinary failure', async () => {
    await renderPanel(FAILED_JOB);

    expect(page.getByRole('button', { name: 'Go to Settings' }).query()).toBeNull();
    expect(page.getByText(/missing or was rejected/).query()).toBeNull();
  });
});
