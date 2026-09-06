import { z } from 'zod';

/**
 * `GET /providers/:provider/authorize` query.
 * `redirect_uri`의 origin 허용 검사는 worker 정책 (ALLOWED_ORIGINS 대조).
 */
export const authorizeQuerySchema = z.object({
  redirect_uri: z.url("Query parameter 'redirect_uri' is required and must be a valid URL"),
});

export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;

/**
 * `POST /tokens` — OAuth 2.0 스타일 grant.
 *
 * - `authorization_code`: callback이 발급한 일회용 code를 토큰 쌍으로 교환.
 *   (레거시의 redirect URL 내 provider access_token 노출을 제거 — 스펙 §10.2)
 * - `refresh_token`: rotation — 기존 refresh token은 즉시 무효화되고,
 *   재사용이 감지되면 해당 세션 계열 전체가 폐기된다.
 */
export const tokenRequestBodySchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1, "Field 'code' is required"),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1, "Field 'refresh_token' is required"),
  }),
]);

export type TokenRequestBody = z.infer<typeof tokenRequestBodySchema>;
