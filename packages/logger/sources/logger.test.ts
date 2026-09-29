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

  describe('credential scrubbing', () => {
    const ANTHROPIC_KEY = 'sk-ant-api03-AAaaBBbbCCcc-99';
    const OPENAI_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz';
    const GOOGLE_KEY = 'AIzaSyD-1234567890abcdefgHIJKLmnop';
    const XAI_KEY = 'xai-abcdef1234567890ABCDEF';
    const JWT =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTUxMTEifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

    test('scrubs message, context, and data', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info(
        `stored key ${ANTHROPIC_KEY}`,
        { providerKey: OPENAI_KEY, nested: { list: [GOOGLE_KEY] } },
        { module: 'vault', metadata: { header: `Bearer ${XAI_KEY}` } },
      );

      const output = infoSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(ANTHROPIC_KEY);
      expect(output).not.toContain(OPENAI_KEY);
      expect(output).not.toContain(GOOGLE_KEY);
      expect(output).not.toContain(XAI_KEY);

      const parsed = JSON.parse(output);
      expect(parsed.message).toBe('stored key sk-[REDACTED]');
      expect(parsed.data).toEqual({
        providerKey: 'sk-[REDACTED]',
        nested: { list: ['AIza[REDACTED]'] },
      });
      expect(parsed.context.module).toBe('vault');
      expect(parsed.context.metadata.header).toBe('Bearer [REDACTED]');
    });

    test('removes a JWT from the log entry', () => {
      const logger = new Logger({ formatAsJSON: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.warn(`rejected token ${JWT}`, { token: JWT });

      const output = warnSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(JWT);
      expect(output).not.toContain('dBjftJeZ4CVP');

      const parsed = JSON.parse(output);
      expect(parsed.message).toBe('rejected token eyJ[REDACTED]');
      expect(parsed.data.token).toBe('eyJ[REDACTED]');
    });

    test('redacts error.message but keeps the status and request id', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error(
        'provider call failed',
        new Error(`401 Unauthorized (request id req_011CXyZAbCdEf): invalid x-api-key ${ANTHROPIC_KEY}`),
        { requestID: 'request-7f3a' },
      );

      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(ANTHROPIC_KEY);

      const parsed = JSON.parse(output);
      expect(parsed.error.message).toBe(
        '401 Unauthorized (request id req_011CXyZAbCdEf): invalid x-api-key sk-[REDACTED]',
      );
      expect(parsed.error.message).toContain('401');
      expect(parsed.error.message).toContain('req_011CXyZAbCdEf');
      expect(parsed.error.stack).not.toContain(ANTHROPIC_KEY);
      expect(parsed.context.requestID).toBe('request-7f3a');
    });

    test('expands and scrubs error.cause instead of serializing it as {}', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cause = new TypeError(`upstream rejected ${OPENAI_KEY}`, {
        cause: new Error(`inner ${GOOGLE_KEY}`),
      });
      logger.error('wrapped failure', new Error('outer', { cause }));

      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(OPENAI_KEY);
      expect(output).not.toContain(GOOGLE_KEY);

      const parsed = JSON.parse(output);
      expect(parsed.error.cause).not.toEqual({});
      expect(parsed.error.cause.name).toBe('TypeError');
      expect(parsed.error.cause.message).toBe('upstream rejected sk-[REDACTED]');
      expect(typeof parsed.error.cause.stack).toBe('string');
      expect(parsed.error.cause.cause.name).toBe('Error');
      expect(parsed.error.cause.cause.message).toBe('inner AIza[REDACTED]');
    });

    test('scrubs request and response bodies in pretty output', () => {
      const logger = new Logger({ formatAsJSON: false, includeTimestamp: false, includeLevel: false });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.logHTTP(
        'provider call',
        {
          method: 'POST',
          url: 'https://api.openai.com/v1/chat/completions',
          headers: { authorization: `Bearer ${OPENAI_KEY}` },
          body: { apiKey: XAI_KEY, prompt: 'hello' },
        },
        {
          status: 401,
          body: `Incorrect API key provided: ${OPENAI_KEY}`,
        },
      );

      const [prefix, ...additionalInfo] = errorSpy.mock.calls[0];
      expect(prefix).toBe('provider call');

      const serialized = JSON.stringify(additionalInfo);
      expect(serialized).not.toContain(OPENAI_KEY);
      expect(serialized).not.toContain(XAI_KEY);
      expect(additionalInfo).toEqual([
        {
          request: {
            method: 'POST',
            url: 'https://api.openai.com/v1/chat/completions',
            headers: { authorization: 'Bearer [REDACTED]' },
            body: { apiKey: 'xai-[REDACTED]', prompt: 'hello' },
          },
        },
        {
          response: {
            status: 401,
            body: 'Incorrect API key provided: sk-[REDACTED]',
          },
        },
      ]);
    });

    test('records circular references without throwing', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const circular: Record<string, unknown> = { key: GOOGLE_KEY };
      circular.self = circular;

      expect(() => logger.info('circular data', circular)).not.toThrow();

      const output = infoSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(GOOGLE_KEY);

      const parsed = JSON.parse(output);
      expect(parsed.data.key).toBe('AIza[REDACTED]');
      expect(parsed.data.self).toBe('[Circular]');
    });

    test('expands a shared reference at every place it appears', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const shared = { token: OPENAI_KEY, region: 'us' };
      const sharedError = new Error(`rejected ${XAI_KEY}`);
      logger.info('shared data', {
        first: shared,
        second: shared,
        list: [shared, shared],
        failures: [sharedError, sharedError],
      });

      const output = infoSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(OPENAI_KEY);
      expect(output).not.toContain(XAI_KEY);
      expect(output).not.toContain('[Circular]');

      const parsed = JSON.parse(output);
      const scrubbedShared = { token: 'sk-[REDACTED]', region: 'us' };
      expect(parsed.data.first).toEqual(scrubbedShared);
      expect(parsed.data.second).toEqual(scrubbedShared);
      expect(parsed.data.list).toEqual([scrubbedShared, scrubbedShared]);
      expect(parsed.data.failures[0].message).toBe('rejected xai-[REDACTED]');
      expect(parsed.data.failures[1].message).toBe('rejected xai-[REDACTED]');
    });

    test('writes a URL as its href with the credential redacted', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const endpoint = new URL(`https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_KEY}`);
      logger.info('provider request', { endpoint });

      const output = infoSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(GOOGLE_KEY);

      const parsed = JSON.parse(output);
      expect(parsed.data.endpoint).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models?key=AIza[REDACTED]',
      );
    });

    test('keeps extra Error properties such as code and status and scrubs them', () => {
      const logger = new Logger({ formatAsJSON: true });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const providerError = Object.assign(new Error('401 Unauthorized'), {
        code: 'invalid_api_key',
        status: 401,
        requestID: 'req_011CXyZAbCdEf',
        headers: { authorization: `Bearer ${XAI_KEY}` },
        body: `Incorrect API key provided: ${OPENAI_KEY}`,
      });
      logger.error('provider call failed', new Error('wrapped', { cause: providerError }));

      const output = errorSpy.mock.calls[0][0] as string;
      expect(output).not.toContain(XAI_KEY);
      expect(output).not.toContain(OPENAI_KEY);

      const parsed = JSON.parse(output);
      expect(parsed.error.cause.name).toBe('Error');
      expect(parsed.error.cause.message).toBe('401 Unauthorized');
      expect(typeof parsed.error.cause.stack).toBe('string');
      expect(parsed.error.cause.code).toBe('invalid_api_key');
      expect(parsed.error.cause.status).toBe(401);
      expect(parsed.error.cause.requestID).toBe('req_011CXyZAbCdEf');
      expect(parsed.error.cause.headers).toEqual({ authorization: 'Bearer [REDACTED]' });
      expect(parsed.error.cause.body).toBe('Incorrect API key provided: sk-[REDACTED]');
    });

    test('replaces deeply nested values with [Truncated]', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      let deep: Record<string, unknown> = { leaf: 'bottom' };
      for (let level = 0; level < 20; level += 1) {
        deep = { child: deep };
      }

      expect(() => logger.info('deep data', deep)).not.toThrow();

      const output = infoSpy.mock.calls[0][0] as string;
      expect(output).toContain('[Truncated]');
      expect(output).not.toContain('bottom');
    });

    test('leaves ordinary words that contain a credential prefix unchanged', () => {
      const logger = new Logger({ formatAsJSON: true });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const message =
        'task-force scheduling, risk-score too high, disk-usage exceeded, desk_assignment pending';
      const data = {
        reason: 'stop_reason=max_tokens',
        code: 'invalid_api_key (401)',
        note: 'after the reorg-chart landed',
        link: 'see the FAQ.Section2 for details',
      };

      logger.info(message, data);

      const parsed = JSON.parse(infoSpy.mock.calls[0][0] as string);
      expect(parsed.message).toBe(message);
      expect(parsed.data).toEqual(data);
    });
  });
});
