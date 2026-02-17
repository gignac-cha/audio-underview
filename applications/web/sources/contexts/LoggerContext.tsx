import { useMemo, type ReactNode } from 'react';
import { createBrowserLogger, type LoggerOptions } from '@audio-underview/logger';
import { LoggerContext } from './logger-context-value.ts';

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
