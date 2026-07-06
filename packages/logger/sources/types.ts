import type { LogLevel } from './levels.ts';

/**
 * 구조화 로그 컨텍스트. `module`은 서비스/패키지 이름, `function`은 호출 지점.
 */
export interface LogContext {
  module?: string;
  function?: string;
  metadata?: Record<string, unknown>;
}

/**
 * transport에 전달되는 단일 로그 레코드.
 */
export interface LogRecord {
  level: LogLevel;
  message: string;
  timestamp: string;
  context: LogContext;
  data?: unknown;
  error?: { name: string; message: string; stack?: string };
}

/**
 * 로그 출력 대상. `flush`는 버퍼링 transport(Axiom 등)가 구현하며,
 * worker에서는 `executionContext.waitUntil(logger.flush())`로 소비한다.
 */
export interface LogTransport {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
}
