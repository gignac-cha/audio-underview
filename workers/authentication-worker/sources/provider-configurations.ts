import type { ProviderConfiguration } from '@audio-underview/authentication-core';
import { oauthProviderIDs, type OAuthProviderID } from '@audio-underview/schemas';
import type { WorkerEnvironment } from './environment.ts';

/**
 * provider별 자격 증명 조립. 필요한 secret이 모두 설정된 provider만 활성화된다 —
 * 레거시처럼 별도 enable 목록을 두지 않고 자격 증명 존재가 곧 활성 (단순화).
 */
export const resolveProviderConfiguration = (
  environment: WorkerEnvironment,
  provider: OAuthProviderID,
): ProviderConfiguration | undefined => {
  switch (provider) {
    case 'google':
      return environment.GOOGLE_CLIENT_ID !== undefined &&
        environment.GOOGLE_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.GOOGLE_CLIENT_ID,
            clientSecret: environment.GOOGLE_CLIENT_SECRET,
          }
        : undefined;
    case 'apple':
      return environment.APPLE_CLIENT_ID !== undefined &&
        environment.APPLE_TEAM_ID !== undefined &&
        environment.APPLE_KEY_ID !== undefined &&
        environment.APPLE_PRIVATE_KEY !== undefined
        ? {
            clientID: environment.APPLE_CLIENT_ID,
            apple: {
              teamID: environment.APPLE_TEAM_ID,
              keyID: environment.APPLE_KEY_ID,
              privateKey: environment.APPLE_PRIVATE_KEY,
            },
          }
        : undefined;
    case 'microsoft':
      return environment.MICROSOFT_CLIENT_ID !== undefined &&
        environment.MICROSOFT_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.MICROSOFT_CLIENT_ID,
            clientSecret: environment.MICROSOFT_CLIENT_SECRET,
            tenant: environment.MICROSOFT_TENANT ?? 'common',
          }
        : undefined;
    case 'facebook':
      return environment.FACEBOOK_CLIENT_ID !== undefined &&
        environment.FACEBOOK_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.FACEBOOK_CLIENT_ID,
            clientSecret: environment.FACEBOOK_CLIENT_SECRET,
          }
        : undefined;
    case 'github':
      return environment.GITHUB_CLIENT_ID !== undefined &&
        environment.GITHUB_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.GITHUB_CLIENT_ID,
            clientSecret: environment.GITHUB_CLIENT_SECRET,
          }
        : undefined;
    case 'discord':
      return environment.DISCORD_CLIENT_ID !== undefined &&
        environment.DISCORD_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.DISCORD_CLIENT_ID,
            clientSecret: environment.DISCORD_CLIENT_SECRET,
          }
        : undefined;
    case 'kakao':
      // kakao의 client_secret은 optional (콘솔 설정에 따라)
      return environment.KAKAO_CLIENT_ID !== undefined
        ? {
            clientID: environment.KAKAO_CLIENT_ID,
            ...(environment.KAKAO_CLIENT_SECRET !== undefined && {
              clientSecret: environment.KAKAO_CLIENT_SECRET,
            }),
          }
        : undefined;
    case 'naver':
      return environment.NAVER_CLIENT_ID !== undefined &&
        environment.NAVER_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.NAVER_CLIENT_ID,
            clientSecret: environment.NAVER_CLIENT_SECRET,
          }
        : undefined;
    case 'linkedin':
      return environment.LINKEDIN_CLIENT_ID !== undefined &&
        environment.LINKEDIN_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.LINKEDIN_CLIENT_ID,
            clientSecret: environment.LINKEDIN_CLIENT_SECRET,
          }
        : undefined;
    case 'x':
      return environment.X_CLIENT_ID !== undefined && environment.X_CLIENT_SECRET !== undefined
        ? {
            clientID: environment.X_CLIENT_ID,
            clientSecret: environment.X_CLIENT_SECRET,
          }
        : undefined;
  }
};

export const listEnabledProviders = (environment: WorkerEnvironment): OAuthProviderID[] =>
  oauthProviderIDs.filter(
    (provider) => resolveProviderConfiguration(environment, provider) !== undefined,
  );
