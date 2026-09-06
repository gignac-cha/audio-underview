import type { LogRecord, LogTransport } from '../types.ts';

export interface ConsoleTransportOptions {
  /**
   * `json`: 한 줄 JSON (worker/서버 — 로그 수집기 친화적).
   * `pretty`: 사람이 읽는 형식 (로컬 개발/브라우저).
   */
  format?: 'json' | 'pretty';
}

const consoleMethodFor = (record: LogRecord): ((...values: unknown[]) => void) => {
  switch (record.level) {
    case 'debug':
      return console.debug;
    case 'info':
      return console.info;
    case 'warn':
      return console.warn;
    case 'error':
      return console.error;
  }
};

export const createConsoleTransport = (options: ConsoleTransportOptions = {}): LogTransport => {
  const format = options.format ?? 'json';

  return {
    write(record: LogRecord): void {
      const method = consoleMethodFor(record);

      if (format === 'json') {
        method(JSON.stringify(record));
        return;
      }

      const scope = [record.context.module, record.context.function]
        .filter((part) => part !== undefined)
        .join('.');
      const prefix = `[${record.timestamp}] ${record.level.toUpperCase()}${scope.length > 0 ? ` (${scope})` : ''}`;
      const extras = [record.data, record.error].filter((part) => part !== undefined);
      method(`${prefix} ${record.message}`, ...extras);
    },
  };
};
