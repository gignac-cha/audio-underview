import {
  consumeAuthorizationCode,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
} from '@audio-underview/authentication-core';
import { tokenRequestBodySchema, type AuthenticatedUser } from '@audio-underview/schemas';
import {
  errorResponse,
  formatValidationIssues,
  jsonResponse,
  readJSONBody,
  type RequestContext,
} from '@audio-underview/worker-foundation';
import { parseAuthenticationEnvironment, type WorkerEnvironment } from '../environment.ts';

type Context = RequestContext<WorkerEnvironment>;

/**
 * `POST /tokens` — OAuth 스타일 grant 2종 (스펙 §4.1 신규 플로우):
 * - `authorization_code`: callback이 발급한 일회용 code → access(1h) + refresh(30d)
 * - `refresh_token`: rotation. 재사용 감지 시 세션 계열 폐기 후 거부.
 */
export const handleTokens = async (context: Context): Promise<Response> => {
  const environment = parseAuthenticationEnvironment(context.environment);

  const body = await readJSONBody(context.request);
  if (!body.success) {
    return errorResponse(
      'invalid_request',
      'Request body must be valid JSON',
      400,
      context.responseContext,
    );
  }
  const parsed = tokenRequestBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      formatValidationIssues(parsed.error),
      400,
      context.responseContext,
    );
  }

  const issueTokenPair = async (
    user: AuthenticatedUser,
    refreshToken: string,
  ): Promise<Response> => {
    const access = await issueAccessToken({
      userUUID: user.uuid,
      secret: environment.JWT_SECRET,
    });
    return jsonResponse(
      {
        access_token: access.token,
        token_type: 'Bearer',
        expires_in: access.expiresIn,
        refresh_token: refreshToken,
        user,
      },
      200,
      context.responseContext,
    );
  };

  if (parsed.data.grant_type === 'authorization_code') {
    const record = await consumeAuthorizationCode(environment.OAUTH_STATE, parsed.data.code);
    if (record === undefined) {
      return errorResponse(
        'invalid_grant',
        'Authorization code is invalid or expired',
        400,
        context.responseContext,
      );
    }
    const refreshToken = await issueRefreshToken(environment.OAUTH_STATE, record.user);
    return issueTokenPair(record.user, refreshToken);
  }

  const rotation = await rotateRefreshToken(environment.OAUTH_STATE, parsed.data.refresh_token);
  if (rotation.outcome === 'reuse_detected') {
    return errorResponse(
      'invalid_grant',
      'Refresh token reuse detected — the session has been revoked',
      400,
      context.responseContext,
    );
  }
  if (rotation.outcome === 'invalid') {
    return errorResponse(
      'invalid_grant',
      'Refresh token is invalid or expired',
      400,
      context.responseContext,
    );
  }
  return issueTokenPair(rotation.user, rotation.refreshToken);
};
