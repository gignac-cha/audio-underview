import { z } from 'zod';
import { DEFAULT_LIST_LIMIT, DEFAULT_LIST_OFFSET, MAXIMUM_LIST_LIMIT } from './limits.ts';

/**
 * list 계열 공통 pagination query.
 * - `offset`: 정수 ≥ 0 (기본 0)
 * - `limit`: 정수 1–100 (기본 20)
 *
 * 참고: 레거시는 빈 문자열 `?offset=`의 해석이 worker마다 달랐다 (스펙 §2.6).
 * 재작성에서는 빈 문자열을 "미지정"으로 통일한다 — 핸들러가 빈 값을 걸러낸 뒤 파싱한다.
 */
export const paginationQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(DEFAULT_LIST_OFFSET),
  limit: z.coerce.number().int().min(1).max(MAXIMUM_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * list 응답 envelope: `{ data, total, offset, limit }`.
 */
export const createListEnvelopeSchema = <ItemSchema extends z.ZodType>(itemSchema: ItemSchema) =>
  z.object({
    data: z.array(itemSchema),
    total: z.number().int().min(0),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
  });
