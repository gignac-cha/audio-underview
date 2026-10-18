import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { page } from 'vitest/browser';
import { RunOutputPanel, type RunOutput } from './RunOutputPanel.tsx';

const FILE_ID = '11111111-1111-4111-8111-111111111111';

const logs = [
  { level: 'info' as const, message: 'fetched the page', timestamp: '2024-01-01T10:00:00' },
  { level: 'warn' as const, message: 'selector is slow', timestamp: '2024-01-01T10:00:01' },
];

function renderPanel(output: RunOutput, caption?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunOutputPanel output={output} caption={caption} />
    </QueryClientProvider>,
  );
}

describe('RunOutputPanel', () => {
  test('shows the idle message before a run', async () => {
    await renderPanel({ status: 'idle' });

    await expect.element(page.getByText('Run a test to see results here.')).toBeVisible();
    expect(page.getByText('Logs', { exact: true }).query()).toBeNull();
  });

  test('shows a spinner message while a run is going', async () => {
    await renderPanel({ status: 'running' });

    await expect.element(page.getByText('Executing...')).toBeVisible();
  });

  test('shows a loading message while a past run loads', async () => {
    await renderPanel({ status: 'loading' });

    await expect.element(page.getByText('Loading...')).toBeVisible();
  });

  test('shows the message of a request that gave no answer, without logs', async () => {
    await renderPanel({ status: 'error', error: new Error('Environment variables are not available right now') });

    await expect.element(page.getByText('Environment variables are not available right now')).toBeVisible();
    expect(page.getByText('Logs', { exact: true }).query()).toBeNull();
  });

  test('shows the result and the logs of a successful run', async () => {
    await renderPanel({ status: 'success', result: { title: 'Hello' }, logs, logsTruncated: false });

    await expect.element(page.getByText('"title"')).toBeVisible();
    await expect.element(page.getByText('"Hello"')).toBeVisible();
    await expect.element(page.getByText('Logs', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('log', { name: 'Crawler logs' })).toHaveTextContent('fetched the page');
    await expect.element(page.getByRole('log', { name: 'Crawler logs' })).toHaveTextContent('selector is slow');
    expect(page.getByText('Logs were truncated.').query()).toBeNull();
  });

  test('says that the logs were truncated', async () => {
    await renderPanel({ status: 'success', result: 1, logs, logsTruncated: true });

    await expect.element(page.getByText('Logs were truncated.')).toBeVisible();
  });

  test('shows the error code, the description and the logs of a failed run', async () => {
    await renderPanel({
      status: 'failed',
      failure: { code: 'execution_failed', description: 'TypeError: body is not a function' },
      logs: [{ level: 'error', message: 'boom', timestamp: '2024-01-01T10:00:00' }],
      logsTruncated: true,
    });

    await expect.element(page.getByText('execution_failed')).toBeVisible();
    await expect.element(page.getByText('TypeError: body is not a function')).toBeVisible();
    await expect.element(page.getByRole('log', { name: 'Crawler logs' })).toHaveTextContent('boom');
    await expect.element(page.getByText('Logs were truncated.')).toBeVisible();
  });

  test('says that a run without logs has none', async () => {
    await renderPanel({ status: 'success', result: {}, logs: [], logsTruncated: false });

    await expect.element(page.getByText('No logs.')).toBeVisible();
  });

  test('lists the files that the result references', async () => {
    await renderPanel({
      status: 'success',
      result: { report: { file_id: FILE_ID, content_type: 'text/csv', size: 10, name: 'report.csv' } },
      logs: [],
      logsTruncated: false,
    });

    await expect.element(page.getByText('Files', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Download report.csv' })).toBeVisible();
  });

  test('shows no file list for a result without file references', async () => {
    await renderPanel({ status: 'success', result: { title: 'x' }, logs: [], logsTruncated: false });

    await expect.element(page.getByText('"title"')).toBeVisible();
    expect(page.getByText('Files', { exact: true }).query()).toBeNull();
  });

  test('shows no file list for a failed run', async () => {
    await renderPanel({
      status: 'failed',
      failure: { code: 'execution_failed', description: 'x' },
      logs: [],
      logsTruncated: false,
    });

    await expect.element(page.getByText('execution_failed')).toBeVisible();
    expect(page.getByText('Files', { exact: true }).query()).toBeNull();
  });

  test('shows whose result it is when there is a caption', async () => {
    await renderPanel({ status: 'idle' }, 'Showing a past test run from Jan 1.');

    await expect.element(page.getByText('Showing a past test run from Jan 1.')).toBeVisible();
  });
});
