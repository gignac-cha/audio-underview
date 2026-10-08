import type { CSSProperties } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { color, durationValue, media, space } from '../tokens.ts';

export type ActivityIndicatorSize = 'text' | 'regular' | 'large';

export interface ActivityIndicatorProps {
  /**
   * `text` sizes the meter from the current font size, as tall as a Hangul
   * glyph, to sit on the baseline of the text beside it (use a flex row with
   * `align-items: baseline`). `regular` is 32px tall, `large` is 48px tall.
   */
  size?: ActivityIndicatorSize;
}

/**
 * Resting level and animation offset for each bar. The offsets are negative so
 * the bars start mid-cycle and never move in unison.
 */
const BARS = [
  { restingLevel: 0.45, delay: '-0.9s' },
  { restingLevel: 0.8, delay: '-0.35s' },
  { restingLevel: 1, delay: '-0.7s' },
  { restingLevel: 0.6, delay: '-0.15s' },
  { restingLevel: 0.35, delay: '-0.55s' },
] as const;

/** Hangul glyphs rise about 0.8em above the baseline; the bars keep the regular size's proportions. */
const DIMENSIONS: Record<ActivityIndicatorSize, { height: string; barWidth: string; gap: string }> = {
  text: { height: '0.8em', barWidth: '0.2em', gap: '0.15em' },
  regular: { height: space[6], barWidth: space[1], gap: space[1] },
  large: { height: space[7], barWidth: `calc(${space[1]} * 1.5)`, gap: space[2] },
};

const level = keyframes`
  0%,
  100% {
    transform: scaleY(0.25);
  }
  50% {
    transform: scaleY(1);
  }
`;

const Meter = styled.span`
  display: inline-flex;
  align-items: flex-end;
`;

const Bar = styled.span`
  display: block;
  height: 100%;
  border-radius: ${space[1]};
  background-color: ${color.accent};
  transform-origin: 50% 100%;
  animation: ${level} ${durationValue.meterCycle} ease-in-out infinite;

  ${media.reducedMotion} {
    animation: none;
    transform: scaleY(var(--resting-level));
  }

  ${media.forcedColors} {
    background-color: CanvasText;
  }
`;

/**
 * An indeterminate activity indicator drawn as a small audio level meter.
 * Decorative: pair it with a `role="status"` text such as `로그인하는 중입니다`.
 * Under reduced motion the bars stand still at different levels.
 */
export function ActivityIndicator({ size: indicatorSize = 'regular' }: ActivityIndicatorProps) {
  const dimensions = DIMENSIONS[indicatorSize];

  return (
    <Meter aria-hidden="true" style={{ height: dimensions.height, gap: dimensions.gap }}>
      {BARS.map((bar) => (
        <Bar
          key={bar.delay}
          style={
            {
              width: dimensions.barWidth,
              animationDelay: bar.delay,
              '--resting-level': bar.restingLevel,
            } as CSSProperties
          }
        />
      ))}
    </Meter>
  );
}
