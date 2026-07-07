import type { z } from 'zod';

export class EnvironmentConfigurationError extends Error {
  constructor(details: string) {
    super(`Server configuration error: ${details}`);
    this.name = 'EnvironmentConfigurationError';
  }
}

/**
 * worker 환경(vars + secrets)을 zod 스키마로 검증한다.
 * 실패는 배포/설정 문제이므로 즉시 throw — 라우터가 500
 * "Server configuration error"로 변환한다.
 */
export const parseEnvironment = <Schema extends z.ZodType>(
  schema: Schema,
  environment: unknown,
): z.infer<Schema> => {
  const result = schema.safeParse(environment);
  if (!result.success) {
    const missing = result.error.issues
      .map((issue) => issue.path.join('.'))
      .filter((path) => path.length > 0)
      .join(', ');
    throw new EnvironmentConfigurationError(
      missing.length > 0 ? `invalid environment variables: ${missing}` : 'invalid environment',
    );
  }
  return result.data;
};
