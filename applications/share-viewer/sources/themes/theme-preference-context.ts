/**
 * Context value for the theme toggle, kept in its own module so the provider
 * component file exports only components (Vite fast refresh requirement).
 */

import { createContext, useContext } from 'react';
import type { ThemePreference, ViewerTheme } from './tokens.ts';
import { LIGHT_THEME } from './tokens.ts';

export interface ThemePreferenceContextValue {
  /** What the reader chose: `light`, `dark`, or `system`. */
  preference: ThemePreference;
  /** The concrete theme in effect once `system` has been resolved. */
  theme: ViewerTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemePreferenceContext = createContext<ThemePreferenceContextValue>({
  preference: 'system',
  theme: LIGHT_THEME,
  setPreference: () => undefined,
});

export function useThemePreference(): ThemePreferenceContextValue {
  return useContext(ThemePreferenceContext);
}
