import { z } from 'zod';

/**
 * web 환경변수 스키마. 부팅 시(main.tsx) validateEnvironment()로 검증한다.
 *
 * URL이 비어 있어도 앱은 기동하되, 해당 서비스를 사용하는 시점에
 * requireServiceURL이 사람이 읽을 수 있는 에러를 던진다.
 */
const serviceURLSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().optional(),
);

export const webEnvironmentSchema = z.object({
  VITE_AUTHENTICATION_WORKER_URL: serviceURLSchema,
  VITE_CRAWLER_MANAGER_WORKER_URL: serviceURLSchema,
  VITE_SCHEDULER_MANAGER_WORKER_URL: serviceURLSchema,
  VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL: serviceURLSchema,
});

export type WebEnvironment = z.infer<typeof webEnvironmentSchema>;
export type ServiceURLKey = keyof WebEnvironment;

let cachedEnvironment: WebEnvironment | undefined;

export const parseWebEnvironment = (raw: Record<string, unknown>): WebEnvironment =>
  webEnvironmentSchema.parse(raw);

/** 부팅 시 1회 호출 — 스키마 위반이면 throw로 기동을 중단한다. */
export const validateEnvironment = (): WebEnvironment => {
  // import.meta.env는 정적 접근이어야 빌드 시 치환된다
  cachedEnvironment = parseWebEnvironment({
    VITE_AUTHENTICATION_WORKER_URL: import.meta.env.VITE_AUTHENTICATION_WORKER_URL,
    VITE_CRAWLER_MANAGER_WORKER_URL: import.meta.env.VITE_CRAWLER_MANAGER_WORKER_URL,
    VITE_SCHEDULER_MANAGER_WORKER_URL: import.meta.env.VITE_SCHEDULER_MANAGER_WORKER_URL,
    VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL: import.meta.env.VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL,
  });
  return cachedEnvironment;
};

export const getEnvironment = (): WebEnvironment => cachedEnvironment ?? validateEnvironment();

const SERVICE_LABELS: Record<ServiceURLKey, string> = {
  VITE_AUTHENTICATION_WORKER_URL: 'Authentication service',
  VITE_CRAWLER_MANAGER_WORKER_URL: 'Crawler service',
  VITE_SCHEDULER_MANAGER_WORKER_URL: 'Scheduler service',
  VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL: 'Code runner service',
};

/** 서비스 base URL — 미설정이면 사용 시점에 명확한 에러. 뒤 슬래시는 제거해 반환. */
export const requireServiceURL = (key: ServiceURLKey): string => {
  const value = getEnvironment()[key];
  if (value === undefined) {
    throw new Error(`${SERVICE_LABELS[key]} is not configured. Set ${key}.`);
  }
  return value.replace(/\/+$/, '');
};
