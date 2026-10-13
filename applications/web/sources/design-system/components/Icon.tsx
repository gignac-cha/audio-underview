import styled from '@emotion/styled';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { size } from '../tokens.ts';

export type IconSize = 'regular' | 'large';

export interface IconProps {
  /** A FontAwesome icon definition, for example `faXmark`. */
  icon: IconDefinition;
  /** `regular` is 20px, `large` is 24px. */
  size?: IconSize;
}

const ICON_DIMENSIONS: Record<IconSize, string> = {
  regular: size.iconRegular,
  large: size.iconLarge,
};

const IconFrame = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;

  svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
`;

/**
 * Draws a FontAwesome icon as inline SVG in the current text color, without
 * FontAwesome's global stylesheet. Decorative: pair it with visible or
 * visually hidden text.
 */
export function Icon({ icon, size: iconSize = 'regular' }: IconProps) {
  const dimension = ICON_DIMENSIONS[iconSize];
  const [width, height, , , pathData] = icon.icon;
  const paths = Array.isArray(pathData) ? pathData : [pathData];

  return (
    <IconFrame aria-hidden="true" style={{ width: dimension, height: dimension }}>
      <svg viewBox={`0 0 ${width} ${height}`} fill="currentColor" focusable="false" xmlns="http://www.w3.org/2000/svg">
        {paths.map((path) => (
          <path key={path} d={path} />
        ))}
      </svg>
    </IconFrame>
  );
}
