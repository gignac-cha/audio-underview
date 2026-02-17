import { useContext } from 'react';
import {
  createBrowserLogger,
  type Logger,
  type LoggerOptions,
} from '@audio-underview/logger';
import { LoggerContext } from '../contexts/logger-context-value.ts';

export function useLogger(context?: { module?: string; function?: string }): Logger {
  const logger = useContext(LoggerContext);

  if (!logger) {
    throw new Error('useLogger must be used within LoggerProvider');
  }

  if (context) {
    return logger.createChild(context);
  }

  return logger;
}

export function createWebLogger(options?: LoggerOptions): Logger {
  return createBrowserLogger({
    minimumLevel: 'debug',
    includeTimestamp: true,
    includeLevel: true,
    defaultContext: {
      module: 'web',
    },
    ...options,
  });
}

export const webLogger = createWebLogger();
