/**
 * Theme plumbing for the viewer: a three-state preference (light / dark /
 * system), persisted in the ONE localStorage key this application owns, fed to
 * Emotion's ThemeProvider and painted onto the document through a Global style.
 *
 * The `system` state stays live — it follows `prefers-color-scheme` as the OS
 * flips, rather than snapshotting it once at load.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Global, ThemeProvider, css } from '@emotion/react';
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveTheme,
  type ThemePreference,
} from './tokens.ts';
import { ThemePreferenceContext } from './theme-preference-context.ts';

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * Storage and matchMedia are both allowed to be missing or to throw (private
 * browsing, an embedded webview, a server-side render, jsdom without the
 * media-query shim). None of that is worth failing a page render over, so both
 * reads degrade to the light default.
 */
function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

function readSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

export interface ViewerThemeProviderProps {
  children: ReactNode;
}

export function ViewerThemeProvider({ children }: ViewerThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(readSystemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia(DARK_SCHEME_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // A reader with storage disabled still gets the theme for this session.
    }
  }, []);

  const theme = resolveTheme(preference, systemPrefersDark);

  const contextValue = useMemo(
    () => ({ preference, theme, setPreference }),
    [preference, theme, setPreference],
  );

  // Tell the browser which scheme is active so form controls, scrollbars, and
  // the range input's own chrome stop rendering in the opposite scheme.
  useEffect(() => {
    document.documentElement.style.colorScheme = theme.name;
    document.documentElement.dataset.theme = theme.name;
  }, [theme.name]);

  return (
    <ThemePreferenceContext value={contextValue}>
      <ThemeProvider theme={theme}>
        <Global
          styles={css`
            *,
            *::before,
            *::after {
              box-sizing: border-box;
            }

            body {
              margin: 0;
              background: ${theme.colours.background};
              color: ${theme.colours.textPrimary};
              font-family:
                'Outfit',
                -apple-system,
                BlinkMacSystemFont,
                'Segoe UI',
                'Apple SD Gothic Neo',
                'Noto Sans KR',
                sans-serif;
              -webkit-font-smoothing: antialiased;
              transition: background 0.2s ease;
            }

            button {
              font: inherit;
              border: none;
              background: none;
              color: inherit;
            }

            a {
              color: ${theme.colours.brandPrimaryStrong};
            }

            :focus-visible {
              outline: 2px solid ${theme.colours.focusRing};
              outline-offset: 2px;
            }
          `}
        />
        {children}
      </ThemeProvider>
    </ThemePreferenceContext>
  );
}
