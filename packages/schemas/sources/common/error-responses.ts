import { z } from 'zod';

/**
 * 모든 worker/function이 반환하는 에러 응답의 단일 형식.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
