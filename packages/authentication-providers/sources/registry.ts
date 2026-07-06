import type { OAuthProviderStrategy } from '@audio-underview/authentication-core';
import type { OAuthProviderID } from '@audio-underview/schemas';
import { appleStrategy } from './providers/apple.ts';
import { discordStrategy } from './providers/discord.ts';
import { facebookStrategy } from './providers/facebook.ts';
import { githubStrategy } from './providers/github.ts';
import { googleStrategy } from './providers/google.ts';
import { kakaoStrategy } from './providers/kakao.ts';
import { linkedinStrategy } from './providers/linkedin.ts';
import { microsoftStrategy } from './providers/microsoft.ts';
import { naverStrategy } from './providers/naver.ts';
import { xStrategy } from './providers/x.ts';

/** provider ID → strategy. 단일 authentication-worker가 이 테이블로 분기한다. */
export const providerStrategies: Record<OAuthProviderID, OAuthProviderStrategy> = {
  google: googleStrategy,
  apple: appleStrategy,
  microsoft: microsoftStrategy,
  facebook: facebookStrategy,
  github: githubStrategy,
  discord: discordStrategy,
  kakao: kakaoStrategy,
  naver: naverStrategy,
  linkedin: linkedinStrategy,
  x: xStrategy,
};

export const getProviderStrategy = (id: OAuthProviderID): OAuthProviderStrategy =>
  providerStrategies[id];
