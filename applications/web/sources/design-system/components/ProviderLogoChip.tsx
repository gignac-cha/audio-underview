import styled from '@emotion/styled';
import type { OAuthProviderID } from '@audio-underview/sign-provider';
import { PROVIDER_LOGOS } from '../provider-logos.ts';
import { color, radius, size } from '../tokens.ts';
import { ProviderLogo } from './ProviderLogo.tsx';

export interface ProviderLogoChipProps {
  provider: OAuthProviderID;
}

/**
 * Google's official sign-in image, drawn at the chip size exactly as the file
 * is. The image is its own white tile, so nothing is painted behind it.
 */
const TileImage = styled.img`
  display: block;
  flex-shrink: 0;
  width: ${size.logoChip};
  height: ${size.logoChip};
  max-width: none;
  user-select: none;
`;

/**
 * A white tile drawn to match Google's image: the same size, corner, and thin
 * grey outline, with the mark centered at the size the "G" has in that image.
 * The chip sets its own background and text color, so hover, focus, and press
 * on the button never reach it, and single-color marks stay dark on the white.
 */
const DrawnChip = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: ${size.logoChip};
  height: ${size.logoChip};
  border: ${size.borderWidth} solid ${color.logoOutline};
  border-radius: ${radius.logoChip};
  background-color: ${color.logoBackground};
  color: ${color.onLogoBackground};
`;

/**
 * A provider's official mark on a white tile, for use inside a filled button.
 * Google's own sign-in image is the tile for Google; every other provider's
 * mark sits on a drawn tile that matches it, so the buttons keep one shape and
 * differ only by logo. Pass it as a large `Button`'s `leading`, which then sets
 * the tile as far from the start edge as from the top and bottom.
 * Decorative: the button label names the provider.
 */
export function ProviderLogoChip({ provider }: ProviderLogoChipProps) {
  const source = PROVIDER_LOGOS[provider];

  if (source.kind === 'tile') {
    return <TileImage data-logo-chip="image" src={source.url} alt="" draggable={false} />;
  }

  return (
    <DrawnChip data-logo-chip="drawn">
      <ProviderLogo provider={provider} size="regular" />
    </DrawnChip>
  );
}
