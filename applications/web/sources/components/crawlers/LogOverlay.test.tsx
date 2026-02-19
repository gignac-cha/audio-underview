import { render } from 'vitest-browser-react';
import { LogOverlay } from './LogOverlay.tsx';
import { page } from '@vitest/browser/context';
import type { LogEntry } from '../../hooks/use-crawler-code-runner.ts';

describe('LogOverlay', () => {
  const entries: LogEntry[] = [
    { id: '1', timestamp: new Date('2024-01-01T10:00:00'), level: 'info', message: 'Log entry 1' },
    { id: '2', timestamp: new Date('2024-01-01T10:00:01'), level: 'success', message: 'Log entry 2' },
  ];

  test('renders dialog with title when open', async () => {
    await render(
      <LogOverlay open={true} onOpenChange={vi.fn()} entries={entries} onClear={vi.fn()} />,
    );

    await expect.element(page.getByText('Status Log')).toBeVisible();
  });

  test('shows log entries', async () => {
    await render(
      <LogOverlay open={true} onOpenChange={vi.fn()} entries={entries} onClear={vi.fn()} />,
    );

    await expect.element(page.getByText('Log entry 1')).toBeVisible();
    await expect.element(page.getByText('Log entry 2')).toBeVisible();
  });

  test('shows Clear button when entries exist', async () => {
    await render(
      <LogOverlay open={true} onOpenChange={vi.fn()} entries={entries} onClear={vi.fn()} />,
    );

    await expect.element(page.getByText('Clear')).toBeVisible();
  });

  test('calls onClear when Clear button is clicked', async () => {
    const onClear = vi.fn();
    await render(
      <LogOverlay open={true} onOpenChange={vi.fn()} entries={entries} onClear={onClear} />,
    );

    await page.getByText('Clear').click();
    expect(onClear).toHaveBeenCalledOnce();
  });
});
