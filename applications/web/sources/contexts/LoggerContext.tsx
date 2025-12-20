import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  createBrowserLogger,
  type Logger,
  type LoggerOptions,
} from '@audio-underview/logger';

const LoggerContext = createContext<Logger | null>(null);

interface LoggerProviderProps {
  children: ReactNode;
  options?: LoggerOptions;
}

/**
 * Provider for the application logger
 */
export function LoggerProvider({ children, options }: LoggerProviderProps) {
  const logger = useMemo(() => {
    return createBrowserLogger({
      minimumLevel: 'debug',
      includeTimestamp: true,
      includeLevel: true,
      defaultContext: {
        module: 'web',
      },
      ...options,
    });
  }, [options]);

  return <LoggerContext.Provider value={logger}>{children}</LoggerContext.Provider>;
}

/**
 * Hook to access the logger
 */
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

/**
 * Create a standalone logger instance for use outside of React components
 */
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

// Export the singleton logger for non-component usage
export const webLogger = createWebLogger();
