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
import googleLogoURL from './logos/google.png';
import naverLogoURL from './logos/naver.svg';

/**
 * How a provider's official mark is drawn.
 *
 * - `fontawesome` and `mask` marks are single-color and take the current text
 *   color.
 * - A `tile` is the provider's own finished image: the mark already sits on
 *   its white tile with its outline, and the image is drawn exactly as the
 *   file is, never recolored.
 */
export type ProviderLogoSource =
  | { kind: 'fontawesome'; icon: IconDefinition }
  | { kind: 'mask'; url: string }
  | { kind: 'tile'; url: string };

/**
 * Official marks for every provider. FontAwesome brands supplies all but two,
 * which are kept as local files so the build bundles them.
 *
 * - Google: brand rules forbid a single-color "G", a self-made icon, and the
 *   older flat four-color "G". `logos/google.png` is Google's own sign-in
 *   asset, copied byte for byte from `signin-assets.zip`:
 *   `Android + Web/PNG @4x/Light/Theme=Light, Show text=No, Shape=Square,
 *   Platform=Android+Web@4x.png` (160 × 160, SHA-256
 *   2bc2ae8e4c67de66d74bf1deed12cd8f22981270266a487576b671b0b4df361c). It is the current gradient "G" on a white rounded square with a thin grey
 *   outline, drawn at 40px as the sign-in chip and at icon size elsewhere.
 * - Naver: FontAwesome has no N symbol. That file pads its viewBox so the
 *   solid N fills about 83% of the box, which matches the optical weight of
 *   the FontAwesome glyphs and their built-in whitespace.
 *
 * Typed as a `Record` so a new `OAuthProviderID` fails typecheck until its
 * logo is added.
 */
export const PROVIDER_LOGOS: Record<OAuthProviderID, ProviderLogoSource> = {
  google: { kind: 'tile', url: googleLogoURL },
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
