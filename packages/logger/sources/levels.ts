export const logLevels = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof logLevels)[number];

export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' && (logLevels as readonly string[]).includes(value);
