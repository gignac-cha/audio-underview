import styled from '@emotion/styled';
import type { OAuthProviderID } from '@audio-underview/sign-provider';
import { PROVIDER_LOGOS } from '../provider-logos.ts';
import { media, size } from '../tokens.ts';
import { Icon, type IconSize } from './Icon.tsx';

export interface ProviderLogoProps {
  provider: OAuthProviderID;
  /** `regular` is 20px, `large` is 24px. */
  size?: IconSize;
}

const LOGO_DIMENSIONS: Record<IconSize, string> = {
  regular: size.iconRegular,
  large: size.iconLarge,
};

const MaskedLogo = styled.span`
  display: inline-block;
  flex-shrink: 0;
  background-color: currentColor;
  mask-repeat: no-repeat;
  mask-position: center;
  mask-size: contain;

  ${media.forcedColors} {
    background-color: CanvasText;
  }
`;

/** Drawn exactly as the file is: no mask, filter, or text color reaches it. */
const TileLogo = styled.img`
  display: inline-block;
  flex-shrink: 0;
  max-width: none;
  user-select: none;
`;

/**
 * A provider's official mark at icon size. Single-color marks take the current
 * text color; Google's mark is its official image (the current "G" on its own
 * white tile), scaled down and never recolored, as its brand rules require.
 * Decorative (hidden from screen readers): the text beside it names the provider.
 */
export function ProviderLogo({ provider, size: logoSize = 'regular' }: ProviderLogoProps) {
  const source = PROVIDER_LOGOS[provider];

  if (source.kind === 'fontawesome') {
    return <Icon icon={source.icon} size={logoSize} />;
  }

  const dimension = LOGO_DIMENSIONS[logoSize];

  if (source.kind === 'tile') {
    return (
      <TileLogo
        src={source.url}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ width: dimension, height: dimension }}
      />
    );
  }

  const mask = `url("${source.url}")`;

  return (
    <MaskedLogo
      aria-hidden="true"
      style={{ width: dimension, height: dimension, maskImage: mask, WebkitMaskImage: mask }}
    />
  );
}
