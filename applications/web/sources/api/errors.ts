import { z } from 'zod';

/**
 * 워커/함수 공통 에러 응답 `{ error, error_description }`을 사람이 읽을 수 있는
 * 메시지로 환원한다 (스펙 §8.4). 두 필드 모두 없을 수 있으므로 방어적으로 파싱한다.
 */
const errorBodySchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** 인증 정보가 없어 요청 자체가 불가능할 때 (토큰 부재). */
export class AuthenticationRequiredError extends ApiError {
  constructor() {
    super('Authentication required. Please sign in.', 401, 'unauthorized');
    this.name = 'AuthenticationRequiredError';
  }
}

/**
 * 실패 응답 body에서 에러 메시지를 도출한다:
 * `error_description ?? error ?? "Request failed with status {n}"`.
 */
export const deriveErrorFromResponse = async (response: Response): Promise<ApiError> => {
  let description: string | undefined;
  let code: string | undefined;
  try {
    const raw: unknown = await response.json();
    const parsed = errorBodySchema.safeParse(raw);
    if (parsed.success) {
      description = parsed.data.error_description ?? parsed.data.error;
      code = parsed.data.error;
    }
  } catch {
    // JSON 파싱 실패 시 status 메시지로 폴백
  }
  return new ApiError(
    description ?? `Request failed with status ${String(response.status)}`,
    response.status,
    code,
  );
};

/** 알 수 없는 예외에서 표시용 메시지를 안전하게 추출한다. */
export const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong.';
};
