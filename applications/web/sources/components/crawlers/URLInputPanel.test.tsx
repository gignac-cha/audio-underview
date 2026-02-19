import { render } from 'vitest-browser-react';
import { URLInputPanel } from './URLInputPanel.tsx';
import { page } from '@vitest/browser/context';

describe('URLInputPanel', () => {
  test('renders with label and input', async () => {
    await render(<URLInputPanel value="" onChange={vi.fn()} />);

    await expect.element(page.getByText('Target URL')).toBeVisible();
    await expect.element(page.getByPlaceholder('https://example.com')).toBeVisible();
  });

  test('displays the provided value', async () => {
    await render(<URLInputPanel value="https://test.com" onChange={vi.fn()} />);

    await expect.element(page.getByPlaceholder('https://example.com')).toHaveValue('https://test.com');
  });

  test('calls onChange when typing', async () => {
    const onChange = vi.fn();
    await render(<URLInputPanel value="" onChange={onChange} />);

    const input = page.getByPlaceholder('https://example.com');
    await input.fill('https://example.org');
    expect(onChange).toHaveBeenCalled();
  });

  test('input is disabled when disabled prop is true', async () => {
    await render(<URLInputPanel value="" onChange={vi.fn()} disabled />);

    const input = page.getByPlaceholder('https://example.com');
    await expect.element(input).toBeDisabled();
  });
});
