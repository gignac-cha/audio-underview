import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { DataInputPanel } from './DataInputPanel.tsx';

describe('DataInputPanel', () => {
  test('renders the label, the value and the hint about the default input', async () => {
    await render(<DataInputPanel value='{"userIds":["a"]}' onChange={vi.fn()} />);

    await expect.element(page.getByLabelText('Input (JSON)')).toHaveValue('{"userIds":["a"]}');
    await expect
      .element(page.getByText('Leave empty to use the default input built from the input schema.'))
      .toBeVisible();
  });

  test('calls onChange with the typed text', async () => {
    const onChange = vi.fn();
    await render(<DataInputPanel value="" onChange={onChange} />);

    await page.getByLabelText('Input (JSON)').fill('{"a":1}');

    expect(onChange).toHaveBeenLastCalledWith('{"a":1}');
  });

  test('shows an error next to the input and marks the input invalid', async () => {
    await render(<DataInputPanel value="{" onChange={vi.fn()} error="Input must be valid JSON." />);

    await expect.element(page.getByRole('alert')).toHaveTextContent('Input must be valid JSON.');
    await expect.element(page.getByLabelText('Input (JSON)')).toHaveAttribute('aria-invalid', 'true');
    expect(page.getByText('Leave empty to use the default input built from the input schema.').query()).toBeNull();
  });

  test('is not marked invalid without an error', async () => {
    await render(<DataInputPanel value="" onChange={vi.fn()} />);

    await expect.element(page.getByLabelText('Input (JSON)')).toHaveAttribute('aria-invalid', 'false');
    expect(page.getByRole('alert').query()).toBeNull();
  });

  test('is disabled while a run is going', async () => {
    await render(<DataInputPanel value="" onChange={vi.fn()} disabled />);

    await expect.element(page.getByLabelText('Input (JSON)')).toBeDisabled();
  });
});
