import { render } from 'vitest-browser-react';
import { JSONResultPanel } from './JSONResultPanel.tsx';
import { page } from '@vitest/browser/context';

describe('JSONResultPanel', () => {
  test('shows idle message when status is idle', async () => {
    await render(<JSONResultPanel result={null} status="idle" />);

    await expect.element(page.getByText('Run a test to see results here.')).toBeVisible();
  });

  test('shows spinner when running', async () => {
    await render(<JSONResultPanel result={null} status="running" />);

    await expect.element(page.getByText('Executing...')).toBeVisible();
  });

  test('shows error message when status is error', async () => {
    await render(
      <JSONResultPanel result={null} status="error" error={new Error('Something went wrong')} />,
    );

    await expect.element(page.getByText('Something went wrong')).toBeVisible();
  });

  test('shows default error when no error object provided', async () => {
    await render(<JSONResultPanel result={null} status="error" />);

    await expect.element(page.getByText('An unknown error occurred.')).toBeVisible();
  });

  test('renders JSON result on success', async () => {
    const result = { type: 'test', result: { message: 'hello' } };
    await render(<JSONResultPanel result={result} status="success" />);

    await expect.element(page.getByText('"message"')).toBeVisible();
    await expect.element(page.getByText('"hello"')).toBeVisible();
  });
});
