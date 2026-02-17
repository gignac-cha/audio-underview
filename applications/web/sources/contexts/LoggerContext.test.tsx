import { describe, test, expect } from 'vitest';
import { renderHook } from 'vitest-browser-react';
import { createWebLogger, useLogger, LoggerProvider } from './LoggerContext.tsx';

describe('createWebLogger', () => {
  test('creates a logger with standard methods', () => {
    const logger = createWebLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  test('creates a logger with custom options', () => {
    const logger = createWebLogger({ minimumLevel: 'error' });
    expect(typeof logger.info).toBe('function');
  });

  test('startTimer returns elapsed milliseconds', () => {
    const logger = createWebLogger();
    const timer = logger.startTimer();
    expect(typeof timer).toBe('function');
    const elapsed = timer();
    expect(typeof elapsed).toBe('number');
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test('createChild returns a child logger', () => {
    const logger = createWebLogger();
    const child = logger.createChild({ module: 'test-module' });
    expect(typeof child.info).toBe('function');
    expect(typeof child.error).toBe('function');
  });
});

describe('useLogger', () => {
  test('returns logger within LoggerProvider', async () => {
    const { result } = await renderHook(() => useLogger(), {
      wrapper: ({ children }) => <LoggerProvider>{children}</LoggerProvider>,
    });
    expect(typeof result.current.info).toBe('function');
    expect(typeof result.current.error).toBe('function');
  });

  test('returns child logger when context is provided', async () => {
    const { result } = await renderHook(() => useLogger({ module: 'test' }), {
      wrapper: ({ children }) => <LoggerProvider>{children}</LoggerProvider>,
    });
    expect(typeof result.current.info).toBe('function');
  });
});
