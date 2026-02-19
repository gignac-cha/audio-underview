import { render } from 'vitest-browser-react';
import { StatusLogPanel } from './StatusLogPanel.tsx';
import { page } from '@vitest/browser/context';
import type { LogEntry } from '../../hooks/use-crawler-code-runner.ts';

describe('StatusLogPanel', () => {
  test('shows empty message when no entries', async () => {
    await render(<StatusLogPanel entries={[]} />);

    await expect.element(page.getByText('No logs yet.')).toBeVisible();
  });

  test('renders log entries', async () => {
    const entries: LogEntry[] = [
      { id: '1', timestamp: new Date('2024-01-01T10:00:00'), level: 'info', message: 'Starting...' },
      { id: '2', timestamp: new Date('2024-01-01T10:00:01'), level: 'success', message: 'Done!' },
    ];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('Starting...')).toBeVisible();
    await expect.element(page.getByText('Done!')).toBeVisible();
  });

  test('renders entry with details', async () => {
    const entries: LogEntry[] = [
      { id: '1', timestamp: new Date('2024-01-01T10:00:00'), level: 'error', message: 'Failed', details: 'timeout' },
    ];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('Failed')).toBeVisible();
    await expect.element(page.getByText('(timeout)')).toBeVisible();
  });

  test('displays timestamps', async () => {
    const entries: LogEntry[] = [
      { id: '1', timestamp: new Date('2024-01-01T10:05:30'), level: 'info', message: 'Test' },
    ];

    await render(<StatusLogPanel entries={entries} />);

    await expect.element(page.getByText('Test')).toBeVisible();
  });
});
