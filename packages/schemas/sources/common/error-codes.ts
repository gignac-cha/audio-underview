/**
 * 전 서비스 공통 에러 코드 어휘. 응답 형식은 항상 `{ error, error_description }`.
 */
export const errorCodes = [
  'invalid_request',
  'invalid_grant',
  'invalid_state',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'server_error',
  'execution_failed',
  'execution_timeout',
  'fetch_failed',
  'fetch_timeout',
  'response_too_large',
  'network_error',
  'invalid_response',
] as const;

export type ErrorCode = (typeof errorCodes)[number];
