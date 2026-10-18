import { render } from 'vitest-browser-react';
import { StatusLogPanel } from './StatusLogPanel.tsx';
import { page } from 'vitest/browser';
import type { CrawlerRunLogEntry } from '../../schemas/crawler-runs.ts';

describe('StatusLogPanel', () => {
  test('shows empty message when no entries', async () => {
    await render(<StatusLogPanel entries={[]} />);

    await expect.element(page.getByText('No logs.')).toBeVisible();
  });

  test('renders the time, level and message of each entry', async () => {
    const entries: CrawlerRunLogEntry[] = [
      { level: 'info', message: 'Starting...', timestamp: '2024-01-01T10:00:00' },
      { level: 'error', message: 'Done!', timestamp: '2024-01-01T10:00:01' },
    ];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('[10:00:00]INFOStarting...')).toBeVisible();
    await expect.element(page.getByText('[10:00:01]ERRORDone!')).toBeVisible();
  });

  test('renders every level of the crawler log', async () => {
    const entries: CrawlerRunLogEntry[] = [
      { level: 'debug', message: 'a', timestamp: '2024-01-01T10:00:00' },
      { level: 'log', message: 'b', timestamp: '2024-01-01T10:00:00' },
      { level: 'warn', message: 'c', timestamp: '2024-01-01T10:00:00' },
    ];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('DEBUG')).toBeVisible();
    await expect.element(page.getByText('LOG', { exact: true })).toBeVisible();
    await expect.element(page.getByText('WARN')).toBeVisible();
  });

  test('keeps the raw text of a timestamp that is not a date', async () => {
    const entries: CrawlerRunLogEntry[] = [{ level: 'info', message: 'Test', timestamp: 'not a date' }];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('[not a date]INFOTest')).toBeVisible();
  });

  test('shows midnight as 00 rather than 24', async () => {
    const entries: CrawlerRunLogEntry[] = [{ level: 'info', message: 'Test', timestamp: '2024-01-01T00:05:30' }];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('[00:05:30]INFOTest')).toBeVisible();
  });
});
