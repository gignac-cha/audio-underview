import styled from '@emotion/styled';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faApple,
  faBluesky,
  faDiscord,
  faFacebook,
  faGithub,
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
import googleLogoURL from '../logos/google.svg';
import naverLogoURL from '../logos/naver.svg';
import { media, size } from '../tokens.ts';
import { Icon, type IconSize } from './Icon.tsx';

/**
 * `fontawesome` and `mask` marks are single-color and take the current text
 * color. A `color` mark is drawn exactly as its file says, brand colors and all.
 */
type LogoSource =
  | { kind: 'fontawesome'; icon: IconDefinition }
  | { kind: 'mask'; url: string }
  | { kind: 'color'; url: string };

/**
 * Official marks for every provider. FontAwesome brands supplies all but two,
 * which are kept as local SVG files.
 *
 * - Google: brand rules allow only the standard color "G", never a
 *   single-color one, so it keeps its four colors. `logos/google.svg` is
 *   Google's own file, copied byte for byte from
 *   https://fonts.gstatic.com/s/i/productlogos/googleg/v6/24px.svg. Its
 *   viewBox leaves 1/24 of the box empty on every side, as Google drew it.
 *   The brand colors live in that file only.
 * - Naver: FontAwesome has no N symbol. That file pads its viewBox so the
 *   solid N fills about 83% of the box, which matches the optical weight of
 *   the FontAwesome glyphs and their built-in whitespace.
 *
 * Typed as a `Record` so a new `OAuthProviderID` fails typecheck until its
 * logo is added.
 */
const PROVIDER_LOGOS: Record<OAuthProviderID, LogoSource> = {
  google: { kind: 'color', url: googleLogoURL },
  github: { kind: 'fontawesome', icon: faGithub },
  apple: { kind: 'fontawesome', icon: faApple },
  microsoft: { kind: 'fontawesome', icon: faMicrosoft },
  facebook: { kind: 'fontawesome', icon: faFacebook },
  x: { kind: 'fontawesome', icon: faXTwitter },
  linkedin: { kind: 'fontawesome', icon: faLinkedin },
  discord: { kind: 'fontawesome', icon: faDiscord },
  kakao: { kind: 'fontawesome', icon: faKakaoTalk },
  naver: { kind: 'mask', url: naverLogoURL },
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

const ColorLogo = styled.img`
  display: inline-block;
  flex-shrink: 0;
  max-width: none;
  user-select: none;
`;

/**
 * A provider's official mark. Single-color marks take the current text color;
 * Google's "G" keeps its standard colors, as its brand rules require.
 * Decorative (hidden from screen readers): the button label names the provider.
 */
export function ProviderLogo({ provider, size: logoSize = 'regular' }: ProviderLogoProps) {
  const source = PROVIDER_LOGOS[provider];

  if (source.kind === 'fontawesome') {
    return <Icon icon={source.icon} size={logoSize} />;
  }

  const dimension = LOGO_DIMENSIONS[logoSize];

  if (source.kind === 'color') {
    return (
      <ColorLogo
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
