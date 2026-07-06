import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_OFFSET,
  MAXIMUM_LIST_LIMIT,
} from '@audio-underview/schemas';

export interface ListOptions {
  offset?: number;
  limit?: number;
}

export interface ListResult<Row> {
  data: Row[];
  total: number;
}

/**
 * PostgREST `.range(from, to)` 파라미터 계산.
 * offset 기본 0(min 0), limit 기본 20(1–100 clamp) — 전 목록 공통 계약.
 */
export const resolveListRange = (options: ListOptions = {}): { from: number; to: number } => {
  const offset = Math.max(0, Math.trunc(options.offset ?? DEFAULT_LIST_OFFSET));
  const limit = Math.min(
    MAXIMUM_LIST_LIMIT,
    Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIST_LIMIT)),
  );
  return { from: offset, to: offset + limit - 1 };
};
