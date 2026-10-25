/**
 * Every component in this app reads `props.theme`, so a bare `render()` would
 * throw on the first styled component. This wraps the real provider rather than
 * a stub theme, which means the tokens themselves stay under test too.
 */

import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { ViewerThemeProvider } from '../themes/ViewerThemeProvider.tsx';

function ThemeWrapper({ children }: { children: ReactNode }) {
  return <ViewerThemeProvider>{children}</ViewerThemeProvider>;
}

export function renderWithTheme(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  return render(ui, { wrapper: ThemeWrapper, ...options });
}
