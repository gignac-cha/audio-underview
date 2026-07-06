import { z } from 'zod';

/**
 * 지원하는 OAuth provider 10종. 전부 단일 authentication-worker의
 * `/providers/:provider/*` 경로로 서비스된다.
 */
export const oauthProviderIDSchema = z.enum([
  'google',
  'apple',
  'microsoft',
  'facebook',
  'github',
  'discord',
  'kakao',
  'naver',
  'linkedin',
  'x',
]);

export type OAuthProviderID = z.infer<typeof oauthProviderIDSchema>;

export const oauthProviderIDs = oauthProviderIDSchema.options;
