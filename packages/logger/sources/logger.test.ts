import { Logger } from './logger.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Logger', () => {
  describe('log level filtering', () => {
    test('debug level outputs all levels', () => {
      const logger = new Logger({ minimumLevel: 'debug', formatAsJSON: true });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(debugSpy).toHaveBeenCalledOnce();
      expect(infoSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    test('info level suppresses debug', () => {
      const logger = new Logger({ minimumLevel: 'info', formatAsJSON: true });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.debug('d');
      logger.info('i');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledOnce();
    });

    test('warn level suppresses debug and info', () => {
      const logger = new Logger({ minimumLevel: 'warn', formatAsJSON: true });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.debug('d');
      logger.info('i');
      logger.warn('w');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
    });

    test('error level suppresses all below', () => {
      const logger = new Logger({ minimumLevel: 'error', formatAsJSON: true });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledOnce();
    });
  });

  describe('enabled option', () => {
    test('disabled logger outputs nothing', () => {
      const logger = new Logger({ enabled: false });
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe('JSON format', () => {
    test('outputs valid JSON string', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test message');

      const output = infoSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.message).toBe('test message');
      expect(parsed.level).toBe('info');
      expect(parsed.timestamp).toBeDefined();
    });

    test('JSON output includes data when provided', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('msg', { key: 'value' });

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.data).toEqual({ key: 'value' });
    });
  });

  describe('pretty format', () => {
    test('includes timestamp when includeTimestamp is true', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test');

      const prefix = infoSpy.mock.calls[0][0] as string;
      expect(prefix).toMatch(/^\[.*\]/);
    });

    test('excludes timestamp when includeTimestamp is false', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: false, includeLevel: false });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test');

      const prefix = infoSpy.mock.calls[0][0] as string;
      expect(prefix).toBe('test');
    });

    test('includes level when includeLevel is true', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: false, includeLevel: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.warn('test');

      const prefix = warnSpy.mock.calls[0][0] as string;
      expect(prefix).toContain('[WARN]');
    });

    test('excludes level when includeLevel is false', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: false, includeLevel: false });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.warn('test');

      const prefix = warnSpy.mock.calls[0][0] as string;
      expect(prefix).not.toContain('[WARN]');
    });

    test('includes module and function in prefix', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: false, includeLevel: false });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test', undefined, { module: 'auth', function: 'login' });

      const prefix = infoSpy.mock.calls[0][0] as string;
      expect(prefix).toContain('[auth]');
      expect(prefix).toContain('[login]');
    });

    test('pretty format includes data as additional argument', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: false, includeLevel: false });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test', { foo: 'bar' });

      expect(infoSpy).toHaveBeenCalledWith('test', { data: { foo: 'bar' } });
    });
  });

  describe('context merging', () => {
    test('merges defaultContext with call context', () => {
      const logger = new Logger({
        formatAsJSON: true,
        defaultContext: { module: 'default-module', userID: 'u1' },
      });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test', undefined, { function: 'myFunc' });

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.context.module).toBe('default-module');
      expect(parsed.context.userID).toBe('u1');
      expect(parsed.context.function).toBe('myFunc');
    });

    test('call context overrides defaultContext', () => {
      const logger = new Logger({
        formatAsJSON: true,
        defaultContext: { module: 'old' },
      });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test', undefined, { module: 'new' });

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.context.module).toBe('new');
    });
  });

  describe('data inclusion', () => {
    test('omits data field when not provided', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test');

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.data).toBeUndefined();
    });
  });

  describe('error formatting', () => {
    test('formats Error instance with name, message, stack', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const err = new TypeError('bad type');
      logger.error('failed', err);

      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.error.name).toBe('TypeError');
      expect(parsed.error.message).toBe('bad type');
      expect(parsed.error.stack).toBeDefined();
    });

    test('formats non-Error as UnknownError', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('failed', 'string error');

      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.error.name).toBe('UnknownError');
      expect(parsed.error.message).toBe('string error');
    });
  });

  describe('HTTP methods', () => {
    test('logRequest logs at info level', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.logRequest('incoming', { method: 'GET', url: '/api' });

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.request.method).toBe('GET');
      expect(parsed.request.url).toBe('/api');
    });

    test('logResponse logs at info for status < 400', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.logResponse('ok', { status: 200 });

      expect(infoSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.response.status).toBe(200);
    });

    test('logResponse logs at error for status >= 400', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.logResponse('fail', { status: 500 });

      expect(errorSpy).toHaveBeenCalledOnce();
      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.response.status).toBe(500);
    });

    test('logHTTP includes both request and response', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.logHTTP('round-trip', { method: 'POST', url: '/api' }, { status: 201 });

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.request.method).toBe('POST');
      expect(parsed.response.status).toBe(201);
    });

    test('logAPIError logs at error level with request, response, and error', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.logAPIError(
        'api fail',
        { method: 'GET', url: '/api' },
        { status: 500 },
        new Error('server error'),
      );

      const parsed = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(parsed.request.method).toBe('GET');
      expect(parsed.response.status).toBe(500);
      expect(parsed.error.message).toBe('server error');
    });
  });

  describe('createChild', () => {
    test('child logger merges parent context with child context', () => {
      const parent = new Logger({
        formatAsJSON: true,
        defaultContext: { module: 'parent' },
      });
      const child = parent.createChild({ function: 'childFunc' });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      child.info('from child');

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.context.module).toBe('parent');
      expect(parsed.context.function).toBe('childFunc');
    });

    test('child inherits parent options', () => {
      const parent = new Logger({
        minimumLevel: 'warn',
        formatAsJSON: true,
      });
      const child = parent.createChild({ module: 'child' });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      child.info('should not appear');
      child.warn('should appear');

      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledOnce();
    });
  });

  describe('startTimer', () => {
    test('returns elapsed time in milliseconds', () => {
      vi.useFakeTimers();
      const logger = new Logger();
      const getElapsed = logger.startTimer();

      vi.advanceTimersByTime(150);
      const elapsed = getElapsed();

      expect(elapsed).toBe(150);
      vi.useRealTimers();
    });
  });

  describe('logWithDuration', () => {
    test('includes durationMilliseconds in metadata', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.logWithDuration('info', 'operation done', 250);

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.context.metadata.durationMilliseconds).toBe(250);
    });

    test('merges durationMilliseconds with existing metadata', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.logWithDuration('info', 'done', 100, undefined, { metadata: { extra: 'val' } });

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.context.metadata.durationMilliseconds).toBe(100);
      expect(parsed.context.metadata.extra).toBe('val');
    });
  });
});
