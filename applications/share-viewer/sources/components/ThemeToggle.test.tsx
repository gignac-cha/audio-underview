/**
 * The theme control is the only piece of state this application persists, so
 * both halves are pinned: the choice takes effect immediately, and it survives
 * a reload through the one localStorage key the app owns.
 */

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithTheme } from '../tests/render-with-theme.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { DARK_THEME, LIGHT_THEME, THEME_STORAGE_KEY } from '../themes/tokens.ts';
import { useThemePreference } from '../themes/theme-preference-context.ts';

/** Surfaces the resolved theme so a test can assert on it without styles. */
function ThemeProbe() {
  const { theme, preference } = useThemePreference();
  return (
    <output data-testid="probe">
      {preference}:{theme.name}:{theme.colours.background}
    </output>
  );
}

describe('ThemeToggle', () => {
  it('defaults to system, which resolves to light when the OS is light', () => {
    renderWithTheme(
      <>
        <ThemeToggle />
        <ThemeProbe />
      </>,
    );

    expect(screen.getByRole('button', { name: '시스템' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('probe')).toHaveTextContent(
      `system:light:${LIGHT_THEME.colours.background}`,
    );
  });

  it('switches to the dark palette and persists the choice', async () => {
    const user = userEvent.setup();
    renderWithTheme(
      <>
        <ThemeToggle />
        <ThemeProbe />
      </>,
    );

    await user.click(screen.getByRole('button', { name: '다크' }));

    expect(screen.getByTestId('probe')).toHaveTextContent(
      `dark:dark:${DARK_THEME.colours.background}`,
    );
    expect(screen.getByRole('button', { name: '다크' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('restores a stored preference on the next visit', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    renderWithTheme(
      <>
        <ThemeToggle />
        <ThemeProbe />
      </>,
    );

    expect(screen.getByTestId('probe')).toHaveTextContent('dark:dark');
  });

  it('ignores a corrupted stored value instead of throwing', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');

    renderWithTheme(
      <>
        <ThemeToggle />
        <ThemeProbe />
      </>,
    );

    expect(screen.getByTestId('probe')).toHaveTextContent('system:light');
  });

  it('offers exactly the three states, with light reachable again', async () => {
    const user = userEvent.setup();
    renderWithTheme(
      <>
        <ThemeToggle />
        <ThemeProbe />
      </>,
    );

    expect(screen.getAllByRole('button')).toHaveLength(3);

    await user.click(screen.getByRole('button', { name: '다크' }));
    await user.click(screen.getByRole('button', { name: '라이트' }));

    expect(screen.getByTestId('probe')).toHaveTextContent('light:light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});
