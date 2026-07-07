import { LOG_LEVEL_VALUES, type LogLevel } from './levels.ts';
import type { LogContext, LogRecord, LogTransport } from './types.ts';

export interface LoggerOptions {
  minimumLevel?: LogLevel;
  defaultContext?: LogContext;
  transports: LogTransport[];
  enabled?: boolean;
}

const serializeError = (error: unknown): LogRecord['error'] => {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'UnknownError', message: String(error) };
};

const mergeContexts = (base: LogContext, overrides?: LogContext): LogContext => ({
  ...base,
  ...overrides,
  metadata:
    base.metadata !== undefined || overrides?.metadata !== undefined
      ? { ...base.metadata, ...overrides?.metadata }
      : undefined,
});

export class Logger {
  readonly #minimumLevel: LogLevel;
  readonly #defaultContext: LogContext;
  readonly #transports: LogTransport[];
  readonly #enabled: boolean;

  constructor(options: LoggerOptions) {
    this.#minimumLevel = options.minimumLevel ?? 'info';
    this.#defaultContext = options.defaultContext ?? {};
    this.#transports = options.transports;
    this.#enabled = options.enabled ?? true;
  }

  debug(message: string, data?: unknown, context?: LogContext): void {
    this.#write('debug', message, { data, context });
  }

  info(message: string, data?: unknown, context?: LogContext): void {
    this.#write('info', message, { data, context });
  }

  warn(message: string, data?: unknown, context?: LogContext): void {
    this.#write('warn', message, { data, context });
  }

  error(message: string, error?: unknown, context?: LogContext): void {
    this.#write('error', message, {
      error: error === undefined ? undefined : serializeError(error),
      context,
    });
  }

  /**
   * 컨텍스트가 병합된 자식 logger. transport/level은 공유한다.
   */
  createChild(context: LogContext): Logger {
    return new Logger({
      minimumLevel: this.#minimumLevel,
      defaultContext: mergeContexts(this.#defaultContext, context),
      transports: this.#transports,
      enabled: this.#enabled,
    });
  }

  /**
   * 버퍼링 transport들의 플러시를 기다린다.
   */
  async flush(): Promise<void> {
    await Promise.all(
      this.#transports.map((transport) => transport.flush?.() ?? Promise.resolve()),
    );
  }

  #write(
    level: LogLevel,
    message: string,
    parts: { data?: unknown; error?: LogRecord['error']; context?: LogContext },
  ): void {
    if (!this.#enabled || LOG_LEVEL_VALUES[level] < LOG_LEVEL_VALUES[this.#minimumLevel]) {
      return;
    }

    const record: LogRecord = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: mergeContexts(this.#defaultContext, parts.context),
      ...(parts.data !== undefined && { data: parts.data }),
      ...(parts.error !== undefined && { error: parts.error }),
    };

    for (const transport of this.#transports) {
      try {
        transport.write(record);
      } catch {
        // transport 실패가 애플리케이션 흐름을 깨서는 안 된다
      }
    }
  }
}
