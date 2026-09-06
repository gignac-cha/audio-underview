/**
 * Postgres/PostgREST 에러 분류.
 *
 * 레거시는 에러 "메시지 문자열" 매칭으로 409/400을 판정했다 (스펙 §10.3, §8.11).
 * 재작성에서는 SQLSTATE 코드(`code`)를 1차 기준으로 삼고, 제약 이름은
 * 메시지/detail에서 보조적으로만 찾는다.
 */

export const POSTGRES_ERROR_CODES = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
} as const;

/** PostgREST "row not found" (`.single()` 결과 없음) */
export const POSTGREST_NO_ROWS_CODE = 'PGRST116';

interface PostgrestErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  details?: string | undefined;
}

/** DatabaseOperationError로 감싸진 경우 원인(PostgrestError)을 꺼내 분류한다. */
const unwrapCause = (error: unknown): unknown =>
  error instanceof DatabaseOperationError && error.cause !== undefined ? error.cause : error;

const asPostgrestError = (error: unknown): PostgrestErrorLike => {
  const unwrapped = unwrapCause(error);
  return typeof unwrapped === 'object' && unwrapped !== null
    ? (unwrapped)
    : {};
};

const textOf = (error: unknown): string => {
  const { message, details } = asPostgrestError(error);
  const own = unwrapCause(error) instanceof Error ? (unwrapCause(error) as Error).message : '';
  return `${message ?? ''}\n${details ?? ''}\n${own}`;
};

export const isNoRowsError = (error: unknown): boolean =>
  asPostgrestError(error).code === POSTGREST_NO_ROWS_CODE;

export const isUniqueViolation = (error: unknown, constraintName?: string): boolean => {
  const candidate = asPostgrestError(error);
  const matchesCode =
    candidate.code === POSTGRES_ERROR_CODES.uniqueViolation ||
    /unique/i.test(textOf(error));
  if (!matchesCode) {
    return false;
  }
  return constraintName === undefined || textOf(error).includes(constraintName);
};

export const isForeignKeyViolation = (error: unknown): boolean => {
  const candidate = asPostgrestError(error);
  return (
    candidate.code === POSTGRES_ERROR_CODES.foreignKeyViolation ||
    /violates foreign key/i.test(textOf(error))
  );
};

/** scheduler당 active run 1개를 강제하는 partial unique index 이름 (migration 006) */
export const ACTIVE_RUN_UNIQUE_INDEX = 'scheduler_runs_one_active_per_scheduler';

export class DatabaseOperationError extends Error {
  constructor(operation: string, entity: string, cause: unknown) {
    const description =
      typeof cause === 'object' && cause !== null && 'message' in cause
        ? String((cause).message)
        : String(cause);
    super(`Failed to ${operation} ${entity}: ${description}`, { cause });
    this.name = 'DatabaseOperationError';
  }
}
