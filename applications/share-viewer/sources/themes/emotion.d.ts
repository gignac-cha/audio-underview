import '@emotion/react';
import type { ViewerTheme } from './tokens.ts';

/**
 * Makes `props.theme` inside every styled component the viewer's own theme
 * object instead of Emotion's empty default.
 */
declare module '@emotion/react' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface Theme extends ViewerTheme {}
}
