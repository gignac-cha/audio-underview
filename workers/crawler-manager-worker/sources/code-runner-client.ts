export interface CodeRunnerResult {
  type: 'web' | 'data';
  mode: 'test' | 'run';
  result: unknown;
}

export function validateCodeRunnerResult(value: unknown): CodeRunnerResult {
  if (value == null || typeof value !== 'object') {
    throw new CodeRunnerExecutionError('invalid_response', 'Expected object from code-runner', 0);
  }
  const record = value as Record<string, unknown>;
  if (record.type !== 'web' && record.type !== 'data') {
    throw new CodeRunnerExecutionError('invalid_response', `Expected type 'web' or 'data', got '${String(record.type)}'`, 0);
  }
  if (record.mode !== 'test' && record.mode !== 'run') {
    throw new CodeRunnerExecutionError('invalid_response', `Expected mode 'test' or 'run', got '${String(record.mode)}'`, 0);
  }
  if (!('result' in record)) {
    throw new CodeRunnerExecutionError('invalid_response', 'Missing result field', 0);
  }
  return { type: record.type, mode: record.mode, result: record.result };
}

export interface CodeRunnerClient {
  run(
    type: 'web' | 'data',
    url: string | undefined,
    data: unknown | undefined,
    code: string,
  ): Promise<CodeRunnerResult>;
}

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

const MAX_RETRY_ATTEMPTS = 2;
const INITIAL_BACKOFF_MILLISECONDS = 1_000;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

interface CodeRunnerRequestBody {
  type: 'web' | 'data';
  mode: 'run';
  url?: string;
  data?: unknown;
  code: string;
}

interface CodeRunnerErrorResponse {
  error_code?: string;
  error_description?: string;
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode >= 500 && statusCode < 600;
}

function buildRequestBody(
  type: 'web' | 'data',
  url: string | undefined,
  data: unknown | undefined,
  code: string,
): CodeRunnerRequestBody {
  if (type === 'web') {
    return { type: 'web', mode: 'run', url, code };
  }
  return { type: 'data', mode: 'run', data, code };
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class HTTPCodeRunnerClient implements CodeRunnerClient {
  private readonly baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/+$/, '');
  }

  async run(
    type: 'web' | 'data',
    url: string | undefined,
    data: unknown | undefined,
    code: string,
  ): Promise<CodeRunnerResult> {
    const requestBody = buildRequestBody(type, url, data, code);
    const endpoint = `${this.baseURL}/run`;

    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const backoffMilliseconds = INITIAL_BACKOFF_MILLISECONDS * Math.pow(2, attempt - 1);
        await delay(backoffMilliseconds);
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
        });
      } catch (error: unknown) {
        lastError = error;
        if (attempt < MAX_RETRY_ATTEMPTS) {
          continue;
        }
        throw new CodeRunnerExecutionError(
          'network_error',
          error instanceof Error ? error.message : 'Unknown network error',
          0,
        );
      }

      if (response.ok) {
        try {
          const result = validateCodeRunnerResult(await response.json());
          return result;
        } catch (error: unknown) {
          throw new CodeRunnerExecutionError(
            'invalid_response',
            error instanceof Error ? error.message : 'Failed to parse code runner response',
            response.status,
          );
        }
      }

      if (isRetryableStatusCode(response.status)) {
        lastError = new CodeRunnerExecutionError(
          'server_error',
          `Server returned ${response.status}`,
          response.status,
        );
        if (attempt < MAX_RETRY_ATTEMPTS) {
          continue;
        }
        throw lastError;
      }

      // 4xx errors fail immediately (user code error) — no retry
      let errorCode = 'execution_error';
      let errorDescription = `Code runner returned HTTP ${response.status}`;

      try {
        const errorBody = (await response.json()) as CodeRunnerErrorResponse;
        errorCode = errorBody.error_code ?? errorCode;
        errorDescription = errorBody.error_description ?? errorDescription;
      } catch {
        // Response body is not valid JSON; use defaults
      }

      throw new CodeRunnerExecutionError(errorCode, errorDescription, response.status);
    }

    // Exhausted all retry attempts — throw the last captured error
    if (lastError instanceof CodeRunnerExecutionError) {
      throw lastError;
    }
    throw new CodeRunnerExecutionError(
      'network_error',
      lastError instanceof Error ? lastError.message : 'Unknown error after retries',
      0,
    );
  }
}
