import {
  codeRunnerResultSchema,
  type CodeRunnerResult,
  type RunCodeRequestBody,
} from '@audio-underview/schemas';

/**
 * code-runner HTTP client — 재시도 계약 (스펙 §3.5):
 * - 요청당 timeout 30초
 * - 네트워크 에러/5xx만 재시도 (최대 2회, backoff 1s → 2s)
 * - 4xx는 사용자 코드 문제로 간주해 즉시 실패
 *
 * 레거시 quirk 수정: 에러 body의 필드는 `error` (기존 client는 존재하지 않는
 * `error_code`를 읽어 항상 fallback이 됐다 — 스펙 §8.2).
 */

export class CodeRunnerExecutionError extends Error {
  readonly errorCode: string;
  readonly errorDescription: string;
  readonly statusCode: number;

  constructor(errorCode: string, errorDescription: string, statusCode: number) {
    super(`CodeRunner error ${statusCode}: [${errorCode}] ${errorDescription}`);
    this.name = 'CodeRunnerExecutionError';
    this.errorCode = errorCode;
    this.errorDescription = errorDescription;
    this.statusCode = statusCode;
  }
}

export interface CodeRunnerClient {
  run(request: RunCodeRequestBody, bearerToken: string): Promise<CodeRunnerResult>;
}

export interface HTTPCodeRunnerClientOptions {
  baseURL: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMilliseconds?: number;
  maximumRetries?: number;
  /** 테스트 주입용 backoff sleep */
  delay?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_MAXIMUM_RETRIES = 2;

const defaultDelay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const parseErrorBody = async (
  response: Response,
): Promise<{ error: string; errorDescription: string }> => {
  try {
    const payload = await response.json<Record<string, unknown>>();
    return {
      error: typeof payload.error === 'string' ? payload.error : 'execution_error',
      errorDescription:
        typeof payload.error_description === 'string'
          ? payload.error_description
          : `HTTP ${response.status}`,
    };
  } catch {
    return { error: 'execution_error', errorDescription: `HTTP ${response.status}` };
  }
};

export const createHTTPCodeRunnerClient = (
  options: HTTPCodeRunnerClientOptions,
): CodeRunnerClient => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const requestTimeout = options.requestTimeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
  const maximumRetries = options.maximumRetries ?? DEFAULT_MAXIMUM_RETRIES;
  const delay = options.delay ?? defaultDelay;
  const runURL = `${options.baseURL.replace(/\/$/, '')}/run`;

  return {
    async run(request, bearerToken) {
      let lastError: CodeRunnerExecutionError | undefined;

      for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
        if (attempt > 0) {
          await delay(1000 * 2 ** (attempt - 1));
        }

        let response: Response;
        try {
          response = await fetchImplementation(runURL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bearerToken}`,
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(requestTimeout),
          });
        } catch (error) {
          // 네트워크 에러/timeout → 재시도 대상
          lastError = new CodeRunnerExecutionError(
            'network_error',
            error instanceof Error ? error.message : 'Network request failed',
            0,
          );
          continue;
        }

        if (response.status >= 500) {
          const { error, errorDescription } = await parseErrorBody(response);
          lastError = new CodeRunnerExecutionError(error, errorDescription, response.status);
          continue;
        }

        if (!response.ok) {
          // 4xx — 사용자 코드/요청 문제, 즉시 실패
          const { error, errorDescription } = await parseErrorBody(response);
          throw new CodeRunnerExecutionError(error, errorDescription, response.status);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new CodeRunnerExecutionError(
            'invalid_response',
            'Code runner returned a non-JSON response',
            response.status,
          );
        }

        const parsed = codeRunnerResultSchema.safeParse(payload);
        if (!parsed.success) {
          throw new CodeRunnerExecutionError(
            'invalid_response',
            'Code runner returned an unexpected response shape',
            response.status,
          );
        }
        return parsed.data;
      }

      throw lastError ?? new CodeRunnerExecutionError('network_error', 'Request failed', 0);
    },
  };
};
