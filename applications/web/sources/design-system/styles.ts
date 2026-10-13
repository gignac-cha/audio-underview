import { css } from '@emotion/react';
import { color, duration, easing, size } from './tokens.ts';

/**
 * Visible keyboard focus: a 3px ink ring outside the element with a gap of
 * canvas between. The ring is ink, not the accent, so a focused teal button
 * reads as outlined rather than as a slightly larger teal block.
 * Pointer clicks do not show it (`:focus-visible`).
 */
export const focusRing = css`
  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: ${size.focusRingWidth} solid ${color.focusRing};
    outline-offset: ${size.focusRingOffset};
  }
`;

/** Hides content visually while keeping it available to screen readers. */
export const visuallyHidden = css`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
`;

/**
 * Cancels the legacy link rules in `styles/global.scss` (bottom border and
 * hover color) for links built with the new design. Set your own hover color
 * after this helper.
 */
export const linkReset = css`
  color: inherit;
  text-decoration: none;
  border-bottom: 0;
  transition:
    color ${duration.quick} ${easing.standard},
    background-color ${duration.quick} ${easing.standard};

  &:hover {
    color: inherit;
    border-bottom: 0;
  }
`;
