import styled from '@emotion/styled';
import type { OAuthProviderID } from '@audio-underview/sign-provider';
import { color, radius, size, space } from '../tokens.ts';
import { ProviderLogo } from './ProviderLogo.tsx';

export interface ProviderLogoChipProps {
  provider: OAuthProviderID;
}

/**
 * Fixed size and padding, whatever the button around it does: Google's brand
 * rules keep the "G" at a fixed size with fixed padding. The chip sets its own
 * background and text color, so hover, focus, and press on the button never
 * reach it, and single-color marks stay dark on the white.
 */
const Chip = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: ${size.logoChip};
  height: ${size.logoChip};
  padding: ${space[2]};
  border-radius: ${radius.logoChip};
  background-color: ${color.logoBackground};
  color: ${color.onLogoBackground};
`;

/**
 * A provider's official mark on a white tile, for use inside a filled button.
 * Google's standard color "G" may only sit on white, so every provider button
 * carries its mark on the same tile: the buttons keep one shape and differ
 * only by logo. Pass it as a large `Button`'s `leading`, which then sets the
 * tile as far from the start edge as from the top and bottom.
 * Decorative: the button label names the provider.
 */
export function ProviderLogoChip({ provider }: ProviderLogoChipProps) {
  return (
    <Chip data-logo-chip="">
      <ProviderLogo provider={provider} size="large" />
    </Chip>
  );
}
