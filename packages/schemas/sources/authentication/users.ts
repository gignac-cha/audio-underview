import { z } from 'zod';
import { oauthProviderIDSchema } from './providers.ts';

/**
 * provider 응답을 정규화한 사용자 표현.
 *
 * `email`은 nullable — x는 email을 제공하지 않고 naver는 비공개일 수 있다.
 * (레거시는 client 측 스키마가 email을 필수로 요구해 x/naver 로그인이 깨지는
 * 비대칭이 있었다 — 스펙 §10.3. 재작성에서는 nullable로 통일.)
 */
export const oauthUserSchema = z.object({
  id: z.string().min(1),
  email: z.email().nullable(),
  name: z.string().min(1),
  picture: z.url().optional(),
  provider: oauthProviderIDSchema,
});

export type OAuthUser = z.infer<typeof oauthUserSchema>;

/**
 * 로그인 완료 후의 사용자 — Supabase `users.uuid`가 항상 포함된다.
 * (레거시는 google/github만 uuid를 발급했다 — 재작성에서는 10개 provider 전부.)
 */
export const authenticatedUserSchema = oauthUserSchema.extend({
  uuid: z.uuid(),
});

export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
