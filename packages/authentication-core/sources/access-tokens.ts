import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';
import { signJWT } from '@audio-underview/worker-foundation';

export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export interface IssueAccessTokenOptions {
  userUUID: string;
  secret: string;
}

/**
 * 자체 access token(JWT HS256, 1시간) 발급.
 * 레거시의 24시간 단일 토큰을 짧은 access + rotating refresh 조합으로 대체 (스펙 §10.8 관련).
 */
export const issueAccessToken = async (
  options: IssueAccessTokenOptions,
): Promise<{ token: string; expiresIn: number }> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = await signJWT(
    {
      sub: options.userUUID,
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_TTL_SECONDS,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      jti: crypto.randomUUID(),
    },
    options.secret,
  );
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
};
