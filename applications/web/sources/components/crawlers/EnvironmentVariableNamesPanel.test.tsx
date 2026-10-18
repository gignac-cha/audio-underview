import { useState } from 'react';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router';
import { page, userEvent } from 'vitest/browser';
import { EnvironmentVariableNamesPanel } from './EnvironmentVariableNamesPanel.tsx';

interface HarnessProperties {
  initialNames?: string[];
  editable?: boolean;
  registeredNames?: ReadonlySet<string>;
  registrationError?: string;
  onChange?: (names: string[]) => void;
}

// Keeps the names in state the way the editor page does, so that an added name stays on the screen
function Harness({
  initialNames = [],
  editable = true,
  registeredNames,
  registrationError,
  onChange,
}: HarnessProperties) {
  const [names, setNames] = useState(initialNames);
  return (
    <MemoryRouter>
      <EnvironmentVariableNamesPanel
        names={names}
        editable={editable}
        onChange={(next) => {
          setNames(next);
          onChange?.(next);
        }}
        registeredNames={registeredNames}
        registrationError={registrationError}
      />
    </MemoryRouter>
  );
}

describe('EnvironmentVariableNamesPanel', () => {
  test('says that nothing is declared and offers an input in edit mode', async () => {
    await render(<Harness />);

    await expect.element(page.getByText('No environment variables declared.')).toBeVisible();
    await expect.element(page.getByLabelText('Environment variables')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Add environment variable name' })).toBeVisible();
  });

  test('has no input or remove button in view mode', async () => {
    await render(<Harness initialNames={['API_TOKEN']} editable={false} />);

    await expect.element(page.getByText('API_TOKEN')).toBeVisible();
    expect(page.getByRole('button', { name: 'Add environment variable name' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Remove API_TOKEN' }).query()).toBeNull();
    expect(page.getByPlaceholder('API_TOKEN').query()).toBeNull();
  });

  test('adds a name with the Add button and clears the input', async () => {
    const onChange = vi.fn();
    await render(<Harness onChange={onChange} />);

    const input = page.getByPlaceholder('API_TOKEN');
    await input.fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();

    expect(onChange).toHaveBeenLastCalledWith(['API_TOKEN']);
    await expect.element(page.getByRole('list', { name: 'Declared environment variables' })).toHaveTextContent('API_TOKEN');
    await expect.element(input).toHaveValue('');
  });

  test('adds a name with the Enter key', async () => {
    const onChange = vi.fn();
    await render(<Harness initialNames={['A_TOKEN']} onChange={onChange} />);

    await page.getByPlaceholder('API_TOKEN').fill('B_TOKEN');
    await userEvent.keyboard('{Enter}');

    expect(onChange).toHaveBeenLastCalledWith(['A_TOKEN', 'B_TOKEN']);
  });

  test('rejects a name that breaks the rule and keeps what was typed', async () => {
    const onChange = vi.fn();
    await render(<Harness onChange={onChange} />);

    const input = page.getByPlaceholder('API_TOKEN');
    await input.fill('api-token');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('^[A-Z_][A-Z0-9_]{0,63}$');
    expect(onChange).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue('api-token');
  });

  test('rejects a name that is declared already', async () => {
    const onChange = vi.fn();
    await render(<Harness initialNames={['API_TOKEN']} onChange={onChange} />);

    await page.getByPlaceholder('API_TOKEN').fill('API_TOKEN');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('API_TOKEN is already declared.');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('rejects a 101st name', async () => {
    const onChange = vi.fn();
    const names = Array.from({ length: 100 }, (_, index) => `NAME_${index}`);
    await render(<Harness initialNames={names} onChange={onChange} />);

    await page.getByPlaceholder('API_TOKEN').fill('ONE_MORE');
    await page.getByRole('button', { name: 'Add environment variable name' }).click();

    await expect.element(page.getByRole('alert')).toHaveTextContent('A crawler can declare at most 100 names.');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('removes a name', async () => {
    const onChange = vi.fn();
    await render(<Harness initialNames={['A_TOKEN', 'B_TOKEN']} onChange={onChange} />);

    await page.getByRole('button', { name: 'Remove A_TOKEN' }).click();

    expect(onChange).toHaveBeenLastCalledWith(['B_TOKEN']);
    expect(page.getByText('A_TOKEN').query()).toBeNull();
    await expect.element(page.getByText('B_TOKEN')).toBeVisible();
  });

  test('marks a registered name as Set and an unregistered one as Not set with a link to Settings', async () => {
    await render(<Harness initialNames={['A_TOKEN', 'B_TOKEN']} registeredNames={new Set(['A_TOKEN'])} />);

    const registeredRow = page.getByRole('listitem').filter({ hasText: 'A_TOKEN' });
    const missingRow = page.getByRole('listitem').filter({ hasText: 'B_TOKEN' });
    // The typing of toHaveTextContent takes a string only, so the exact match is polled on the text
    await expect.poll(() => registeredRow.element().textContent).toMatch(/^A_TOKEN\s*Set$/);
    await expect.element(missingRow).toHaveTextContent('Not set');
    await expect.element(page.getByRole('link', { name: 'Set B_TOKEN in Settings' })).toHaveAttribute('href', '/settings');
    expect(page.getByRole('link', { name: 'Set A_TOKEN in Settings' }).query()).toBeNull();
  });

  test('opens the Settings link in a new tab so that unsaved edits are kept', async () => {
    await render(<Harness initialNames={['B_TOKEN']} registeredNames={new Set()} />);

    const link = page.getByRole('link', { name: 'Set B_TOKEN in Settings' });
    await expect.element(link).toHaveAttribute('href', '/settings');
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('shows no registration while the account list is not known', async () => {
    await render(<Harness initialNames={['A_TOKEN']} registeredNames={undefined} />);

    await expect.poll(() => page.getByRole('listitem').element().textContent).toBe('A_TOKEN');
    expect(page.getByRole('link', { name: /in Settings/ }).query()).toBeNull();
  });

  test('says why the registration is not known', async () => {
    await render(
      <Harness
        initialNames={['A_TOKEN']}
        registeredNames={undefined}
        registrationError="Environment variables are not available right now"
      />,
    );

    await expect
      .element(page.getByText('Could not check which names are set: Environment variables are not available right now'))
      .toBeVisible();
  });
});
