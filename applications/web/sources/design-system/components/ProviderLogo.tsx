import styled from '@emotion/styled';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faApple,
  faBluesky,
  faDiscord,
  faFacebook,
  faGithub,
  faGoogle,
  faKakaoTalk,
  faLine,
  faLinkedin,
  faMicrosoft,
  faThreads,
  faTiktok,
  faTwitch,
  faXTwitter,
} from '@fortawesome/free-brands-svg-icons';
import type { OAuthProviderID } from '@audio-underview/sign-provider';
import naverLogoURL from '../logos/naver.svg';
import { media, size } from '../tokens.ts';
import { Icon, type IconSize } from './Icon.tsx';

type LogoSource = { kind: 'fontawesome'; icon: IconDefinition } | { kind: 'file'; url: string };

/**
 * Official marks for every provider. FontAwesome brands supplies all but
 * Naver, whose N symbol is kept as a local SVG file. That file pads its
 * viewBox so the solid N fills about 83% of the box, which matches the optical
 * weight of the FontAwesome glyphs and their built-in whitespace. Typed as a
 * `Record` so a new `OAuthProviderID` fails typecheck until its logo is added.
 */
const PROVIDER_LOGOS: Record<OAuthProviderID, LogoSource> = {
  google: { kind: 'fontawesome', icon: faGoogle },
  github: { kind: 'fontawesome', icon: faGithub },
  apple: { kind: 'fontawesome', icon: faApple },
  microsoft: { kind: 'fontawesome', icon: faMicrosoft },
  facebook: { kind: 'fontawesome', icon: faFacebook },
  x: { kind: 'fontawesome', icon: faXTwitter },
  linkedin: { kind: 'fontawesome', icon: faLinkedin },
  discord: { kind: 'fontawesome', icon: faDiscord },
  kakao: { kind: 'fontawesome', icon: faKakaoTalk },
  naver: { kind: 'file', url: naverLogoURL },
  threads: { kind: 'fontawesome', icon: faThreads },
  tiktok: { kind: 'fontawesome', icon: faTiktok },
  line: { kind: 'fontawesome', icon: faLine },
  bluesky: { kind: 'fontawesome', icon: faBluesky },
  twitch: { kind: 'fontawesome', icon: faTwitch },
};

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

/**
 * A provider's official mark drawn in the current text color, so every
 * provider button shares one shape and color and differs only by logo.
 * Decorative (hidden from screen readers): the button label names the provider.
 */
export function ProviderLogo({ provider, size: logoSize = 'regular' }: ProviderLogoProps) {
  const source = PROVIDER_LOGOS[provider];

  if (source.kind === 'fontawesome') {
    return <Icon icon={source.icon} size={logoSize} />;
  }

  const dimension = LOGO_DIMENSIONS[logoSize];
  const mask = `url("${source.url}")`;

  return (
    <MaskedLogo
      aria-hidden="true"
      style={{ width: dimension, height: dimension, maskImage: mask, WebkitMaskImage: mask }}
    />
  );
}
