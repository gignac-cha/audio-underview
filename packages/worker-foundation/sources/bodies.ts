import { paginationQuerySchema, type PaginationQuery } from '@audio-underview/schemas';
import type { z } from 'zod';

export type BodyResult<Value> = { success: true; value: Value } | { success: false };

/** JSON body 파싱 — 실패 시 400 `invalid_request` 처리용 실패 결과 반환. */
export const readJSONBody = async (request: Request): Promise<BodyResult<unknown>> => {
  try {
    return { success: true, value: await request.json() };
  } catch {
    return { success: false };
  }
};

/** zod 이슈를 error_description 한 문장으로. */
export const formatValidationIssues = (error: z.ZodError): string =>
  error.issues[0]?.message ?? 'Invalid request body';

export type PaginationResult =
  | { success: true; value: PaginationQuery }
  | { success: false; errorDescription: string };

/**
 * list 계열 pagination query 파싱.
 * 빈 문자열(`?offset=`)은 "미지정"으로 취급한다 (레거시 worker 간 불일치 통일 — 스펙 §2.6).
 */
export const readPaginationQuery = (url: URL): PaginationResult => {
  const raw: Record<string, string> = {};
  for (const key of ['offset', 'limit'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value.trim().length > 0) {
      raw[key] = value;
    }
  }

  const parsed = paginationQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      errorDescription:
        "Query parameters 'offset' (integer >= 0) and 'limit' (integer 1-100) must be valid",
    };
  }
  return { success: true, value: parsed.data };
};
