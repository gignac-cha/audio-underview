/**
 * Three-state theme control. `system` is a real option rather than a hidden
 * default, so a reader can see (and undo) the fact that the page is following
 * their OS setting.
 */

import styled from '@emotion/styled';
import { THEME_PREFERENCES, type ThemePreference } from '../themes/tokens.ts';
import { useThemePreference } from '../themes/theme-preference-context.ts';

const PREFERENCE_LABELS: Record<ThemePreference, string> = {
  light: '라이트',
  dark: '다크',
  system: '시스템',
};

const Group = styled.div`
  display: inline-flex;
  padding: 0.1875rem;
  gap: 0.125rem;
  border-radius: 999px;
  background: ${(props) => props.theme.colours.surfaceAlternate};
  border: 1px solid ${(props) => props.theme.colours.border};
`;

const Option = styled.button<{ selected: boolean }>`
  padding: 0.25rem 0.625rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: ${(props) => (props.selected ? 700 : 500)};
  cursor: pointer;
  color: ${(props) =>
    props.selected ? props.theme.colours.surface : props.theme.colours.textSecondary};
  background: ${(props) =>
    props.selected ? props.theme.colours.brandPrimaryStrong : 'transparent'};
  transition:
    background 0.15s ease,
    color 0.15s ease;

  &:hover {
    color: ${(props) =>
      props.selected ? props.theme.colours.surface : props.theme.colours.textPrimary};
  }
`;

export function ThemeToggle() {
  const { preference, setPreference } = useThemePreference();

  return (
    <Group role="group" aria-label="테마 선택">
      {THEME_PREFERENCES.map((candidate) => (
        <Option
          key={candidate}
          type="button"
          selected={candidate === preference}
          aria-pressed={candidate === preference}
          onClick={() => setPreference(candidate)}
        >
          {PREFERENCE_LABELS[candidate]}
        </Option>
      ))}
    </Group>
  );
}
