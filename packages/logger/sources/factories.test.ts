import { Logger } from './logger.ts';
import {
  createBrowserLogger,
  createWorkerLogger,
  createServerLogger,
  createAutoLogger,
  getLogLevelFromEnvironment,
} from './factories.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createBrowserLogger', () => {
  test('returns a Logger instance', () => {
    expect(createBrowserLogger()).toBeInstanceOf(Logger);
  });

  test('uses pretty format (not JSON)', () => {
    const logger = createBrowserLogger();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test');

    const output = infoSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(output)).toThrow();
  });

  test('defaults to debug minimumLevel', () => {
    const logger = createBrowserLogger();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.debug('test');

    expect(debugSpy).toHaveBeenCalledOnce();
  });

  test('allows option override', () => {
    const logger = createBrowserLogger({ minimumLevel: 'error' });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.debug('test');

    expect(debugSpy).not.toHaveBeenCalled();
  });
});

describe('createWorkerLogger', () => {
  test('returns a Logger instance', () => {
    expect(createWorkerLogger()).toBeInstanceOf(Logger);
  });

  test('uses JSON format', () => {
    const logger = createWorkerLogger();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test');

    const output = infoSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(output)).not.toThrow();
  });

  test('defaults to debug minimumLevel', () => {
    const logger = createWorkerLogger();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.debug('test');

    expect(debugSpy).toHaveBeenCalledOnce();
  });
});

describe('createServerLogger', () => {
  test('returns a Logger instance', () => {
    expect(createServerLogger()).toBeInstanceOf(Logger);
  });

  test('uses JSON format', () => {
    const logger = createServerLogger();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test');

    const output = infoSpy.mock.calls[0][0] as string;
    expect(() => JSON.parse(output)).not.toThrow();
  });

  test('defaults to info minimumLevel', () => {
    const logger = createServerLogger();
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.debug('test');

    expect(debugSpy).not.toHaveBeenCalled();
  });
});

describe('getLogLevelFromEnvironment', () => {
  test('returns LOG_LEVEL env var when set and valid', () => {
    vi.stubGlobal('process', { env: { LOG_LEVEL: 'warn' } });
    expect(getLogLevelFromEnvironment()).toBe('warn');
  });

  test('returns debug for NODE_ENV=development', () => {
    vi.stubGlobal('process', { env: { NODE_ENV: 'development' } });
    expect(getLogLevelFromEnvironment()).toBe('debug');
  });

  test('returns info for NODE_ENV=production', () => {
    vi.stubGlobal('process', { env: { NODE_ENV: 'production' } });
    expect(getLogLevelFromEnvironment()).toBe('info');
  });

  test('returns default level when no env vars set', () => {
    vi.stubGlobal('process', { env: {} });
    expect(getLogLevelFromEnvironment('error')).toBe('error');
  });

  test('returns info as fallback default', () => {
    vi.stubGlobal('process', { env: {} });
    expect(getLogLevelFromEnvironment()).toBe('info');
  });

  test('ignores invalid LOG_LEVEL values', () => {
    vi.stubGlobal('process', { env: { LOG_LEVEL: 'verbose' } });
    expect(getLogLevelFromEnvironment()).toBe('info');
  });
});

describe('createAutoLogger', () => {
  test('creates browser logger when window and document exist', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    const logger = createAutoLogger();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test');

    const output = infoSpy.mock.calls[0][0] as string;
    // Browser logger uses pretty format
    expect(() => JSON.parse(output)).toThrow();
  });

  test('creates worker logger when caches.default exists', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('caches', { default: {} });
    const logger = createAutoLogger();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test');

    const output = infoSpy.mock.calls[0][0] as string;
    // Worker logger uses JSON format
    expect(() => JSON.parse(output)).not.toThrow();
  });

  test('creates server logger as default fallback', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('caches', undefined);
    const logger = createAutoLogger();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    logger.info('test');

    const output = infoSpy.mock.calls[0][0] as string;
    // Server logger uses JSON format
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
