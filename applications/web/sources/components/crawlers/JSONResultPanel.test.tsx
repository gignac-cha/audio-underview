import { render } from 'vitest-browser-react';
import { JSONResultPanel } from './JSONResultPanel.tsx';
import { page } from 'vitest/browser';

describe('JSONResultPanel', () => {
  test('shows idle message when status is idle', async () => {
    await render(<JSONResultPanel result={undefined} status="idle" />);

    await expect.element(page.getByText('Run a test to see results here.')).toBeVisible();
  });

  test('shows spinner when running', async () => {
    await render(<JSONResultPanel result={undefined} status="running" />);

    await expect.element(page.getByText('Executing...')).toBeVisible();
  });

  test('shows error message when status is error', async () => {
    await render(
      <JSONResultPanel result={undefined} status="error" error={new Error('Something went wrong')} />,
    );

    await expect.element(page.getByText('Something went wrong')).toBeVisible();
  });

  test('shows default error when no error object provided', async () => {
    await render(<JSONResultPanel result={undefined} status="error" />);

    await expect.element(page.getByText('An unknown error occurred.')).toBeVisible();
  });

  test('renders JSON result on success', async () => {
    const result = { result: { message: 'hello' } };
    await render(<JSONResultPanel result={result} status="success" />);

    await expect.element(page.getByText('"message"')).toBeVisible();
    await expect.element(page.getByText('"hello"')).toBeVisible();
  });

  test('shows the code and description of a failed run', async () => {
    await render(
      <JSONResultPanel
        result={undefined}
        status="failed"
        failure={{ code: 'execution_failed', description: 'TypeError: x is not a function' }}
      />,
    );

    await expect.element(page.getByText('execution_failed')).toBeVisible();
    await expect.element(page.getByText('TypeError: x is not a function')).toBeVisible();
  });

  test('shows a loading message while a past run is fetched', async () => {
    await render(<JSONResultPanel result={undefined} status="loading" />);

    await expect.element(page.getByText('Loading...')).toBeVisible();
  });

  test('offers Copy only for a successful result', async () => {
    await render(
      <JSONResultPanel result={undefined} status="failed" failure={{ code: 'execution_failed', description: 'x' }} />,
    );

    expect(page.getByRole('button', { name: 'Copy' }).query()).toBeNull();
  });
});
