import { z } from 'zod';
import { authenticatedUserSchema } from './users.ts';

/**
 * `POST /tokens` 성공 응답 (두 grant 공통).
 * `user`가 항상 포함되므로 클라이언트는 redirect 쿼리에서 사용자 정보를 받지 않는다.
 */
export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string(),
  user: authenticatedUserSchema,
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
