import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { SYSTEM_USER_UUID } from '@audio-underview/supabase-connector';
import {
  CRAWLER_WORKER_OPTIONS,
  createIsolateID,
  isCPULimitError,
  runCrawler,
  runLoadedCrawler,
  validateRunContext,
} from '../sources/crawler-runtime/run-crawler.ts';
import { RUNNER_MODULE_SOURCE } from '../sources/crawler-runtime/runner-module.ts';
import type CrawlerManagerWorker from '../sources/index.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import {
  CODE_RUNNER_ORIGIN,
  SUPABASE_ORIGIN,
  addCrawler,
  configureVault,
  crawlerRow,
  createRecordingLoader,
  createTestDependencies,
  mockPageBody,
  uniqueUUID,
  vaultEnvironment,
  vaultRequests,
} from './runtime-harness.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

type Completed = Extract<CrawlerRunOutcome, { status: 'completed' }>;
type Failed = Extract<CrawlerRunOutcome, { status: 'failed' }>;

function expectCompleted(outcome: CrawlerRunOutcome): Completed {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'completed' });
  return outcome as Completed;
}

function expectFailed(outcome: CrawlerRunOutcome): Failed {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'failed' });
  return outcome as Failed;
}

async function runCode(code: string, input: unknown = {}, options: { userUUID?: string; dependencies?: ReturnType<typeof createTestDependencies> } = {}) {
  const userUUID = options.userUUID ?? uniqueUUID();
  const crawler = addCrawler(supabase, crawlerRow({ code }));
  const dependencies = options.dependencies ?? createTestDependencies();
  const outcome = await runCrawler(dependencies, crawler.id, input, { userUUID });
  return { outcome, crawler, dependencies, userUUID };
}

describe('running crawler code', () => {
  it('runs a data crawler on its input', async () => {
    const { outcome } = await runCode('(input) => ({ doubled: input.value * 2 })', { value: 21 });

    expect(expectCompleted(outcome)).toEqual({
      status: 'completed',
      type: 'data',
      result: { doubled: 42 },
      logs: [],
      logs_truncated: false,
    });
  });

  it('runs a web crawler on the page body the code runner Lambda fetched', async () => {
    const page = mockPageBody('<title>Hello</title>');
    const crawler = addCrawler(supabase, crawlerRow({
      type: 'web',
      url_pattern: '^https://example\\.com/.*$',
      code: '(body) => body.match(/<title>(.*)<\\/title>/)[1]',
    }));

    const outcome = await runCrawler(createTestDependencies(), crawler.id, { url: 'https://example.com/page' }, { userUUID: uniqueUUID() });

    expect(expectCompleted(outcome)).toMatchObject({ type: 'web', result: 'Hello' });
    expect(page.requests).toEqual([{ type: 'web', mode: 'run', url: 'https://example.com/page', code: '(body) => body' }]);
  });

  it('runs existing (body) => ... code unchanged', async () => {
    mockPageBody('plain text');
    const crawler = addCrawler(supabase, crawlerRow({
      type: 'web',
      url_pattern: '.*',
      code: '(body) => body.toUpperCase().split(" ")',
    }));

    const outcome = await runCrawler(createTestDependencies(), crawler.id, { url: 'https://example.com/' }, { userUUID: uniqueUUID() });

    expect(expectCompleted(outcome).result).toEqual(['PLAIN', 'TEXT']);
  });

  it('keeps sloppy mode', async () => {
    const { outcome } = await runCode('(body) => { counter = 1; return counter; }');

    expect(expectCompleted(outcome).result).toBe(1);
  });

  it('runs sloppy-only syntax: octal literals, arguments.callee and with', async () => {
    const { outcome } = await runCode('(function (body) { with ({ a: 010 }) { return [a, typeof arguments.callee]; } })');

    expect(expectCompleted(outcome).result).toEqual([8, 'function']);
  });

  it('answers undefined as null', async () => {
    const { outcome } = await runCode('(input) => undefined');

    expect(expectCompleted(outcome).result).toBeNull();
  });

  it('awaits an async crawler', async () => {
    const { outcome } = await runCode('async (input) => { await new Promise((resolve) => setTimeout(resolve, 5)); return "later"; }');

    expect(expectCompleted(outcome).result).toBe('later');
  });

  it('fails eval and new Function with execution_failed', async () => {
    for (const code of ['(input) => eval("1 + 1")', '(input) => new Function("return 2")()']) {
      const outcome = expectFailed((await runCode(code)).outcome);

      expect(outcome.error_code).toBe('execution_failed');
      expect(outcome.error_description).toContain('Code generation from strings disallowed');
      expect(outcome.error).toBe(`CodeRunner error 422: [execution_failed] ${outcome.error_description}`);
    }
  });

  it('fails a result that is not JSON with execution_failed', async () => {
    for (const code of ['(input) => ({ big: 10n })', '(input) => { const a = {}; a.self = a; return a; }']) {
      const outcome = expectFailed((await runCode(code)).outcome);

      expect(outcome.error_code).toBe('execution_failed');
      expect(outcome.error).toMatch(/^CodeRunner error 422: \[execution_failed\] /);
    }
  });

  it('fails a syntax error with execution_failed', async () => {
    const outcome = expectFailed((await runCode('(input) => {')).outcome);

    expect(outcome.error_code).toBe('execution_failed');
    expect(outcome.error).toMatch(/^CodeRunner error 422: \[execution_failed\] /);
    expect(outcome.logs).toEqual([]);
  });

  it('fails code that is not a function with execution_failed', async () => {
    const outcome = expectFailed((await runCode('42')).outcome);

    expect(outcome).toMatchObject({
      error_code: 'execution_failed',
      error: 'CodeRunner error 422: [execution_failed] Crawler code must evaluate to a function',
      error_description: 'Crawler code must evaluate to a function',
    });
  });

  it('uses the message of a thrown Error and the text of anything else thrown', async () => {
    const errorOutcome = expectFailed((await runCode('(input) => { throw new RangeError("out of range"); }')).outcome);
    const textOutcome = expectFailed((await runCode('(input) => { throw "plain text"; }')).outcome);

    expect(errorOutcome.error).toBe('CodeRunner error 422: [execution_failed] out of range');
    expect(textOutcome.error).toBe('CodeRunner error 422: [execution_failed] plain text');
  });

  it('keeps the logs and a safe description when reading the thrown Error throws', async () => {
    const { outcome } = await runCode(`(input) => {
      console.log('before');
      const error = new Error('hidden');
      Object.defineProperty(error, 'message', { get() { throw new Error('message getter'); } });
      Object.defineProperty(error, 'stack', { get() { throw new Error('stack getter'); } });
      throw error;
    }`);

    const failed = expectFailed(outcome);
    expect(failed).toMatchObject({ error_code: 'execution_failed', error_description: '[object Error]' });
    expect(failed.logs.map(({ level, message }) => [level, message])).toEqual([['log', 'before']]);
  });

  it('keeps the logs and a safe description when anything read from the thrown value throws', async () => {
    const { outcome } = await runCode(`(input) => {
      console.log('before');
      const trap = () => { throw new Error('trap'); };
      throw new Proxy({}, { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap, has: trap });
    }`);

    const failed = expectFailed(outcome);
    expect(failed).toMatchObject({ error_code: 'execution_failed', error_description: 'Unknown execution error' });
    expect(failed.logs.map(({ level, message }) => [level, message])).toEqual([['log', 'before']]);
  });

  it('cuts the error message to 2000 characters', async () => {
    const outcome = expectFailed((await runCode('(input) => { throw new Error("x".repeat(5000)); }')).outcome);

    expect(outcome.error_description).toBe('x'.repeat(2000));
  });

  it('fails code longer than 1048576 characters with execution_failed without loading it', async () => {
    const { loader, calls } = createRecordingLoader();
    const code = `(input) => ${JSON.stringify('a'.repeat(1_048_576))}`;
    const outcome = expectFailed((await runCode(code, {}, { dependencies: createTestDependencies({ loader }) })).outcome);

    expect(outcome.error).toBe('CodeRunner error 422: [execution_failed] Crawler code exceeds the maximum length of 1048576 characters');
    expect(calls).toEqual([]);
  });

  it('fails a web crawler without a URL with invalid_input and the error without a prefix', async () => {
    const crawler = addCrawler(supabase, crawlerRow({ type: 'web', url_pattern: '.*', input_schema: { body: 'string' } }));

    const outcome = expectFailed(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: uniqueUUID() }));
    const message = `Crawler ${crawler.id}: no URL available. Provide url in input or set a default in input_schema.`;

    expect(outcome).toEqual({
      status: 'failed',
      type: 'web',
      error_code: 'invalid_input',
      error: message,
      error_description: message,
      logs: [],
      logs_truncated: false,
    });
  });

  it('throws when the crawler does not exist', async () => {
    const crawlerID = uniqueUUID();

    await expect(runCrawler(createTestDependencies(), crawlerID, {}, { userUUID: uniqueUUID() })).rejects.toThrow(
      `Crawler ${crawlerID} not found`,
    );
  });

  it('throws on a database error', async () => {
    supabase.intercept = () => ({ statusCode: 500, data: { code: 'XX000', message: 'database is down' } });

    await expect(runCrawler(createTestDependencies(), uniqueUUID(), {}, { userUUID: uniqueUUID() })).rejects.toThrow(
      'Failed to get crawler by ID',
    );
  });
});

describe('validateRunContext', () => {
  it('accepts a user UUID with or without a run ID', () => {
    const userUUID = uniqueUUID();
    const runID = uniqueUUID();

    expect(validateRunContext({ userUUID })).toEqual({ userUUID });
    expect(validateRunContext({ userUUID, runID })).toEqual({ userUUID, runID });
  });

  it.each([undefined, null, 'user', {}, { userUUID: 'not-a-uuid' }, { userUUID: 42 }])('throws Invalid user UUID for %j', (context) => {
    expect(() => validateRunContext(context)).toThrow('Invalid user UUID');
  });

  it('throws Invalid run ID for a run ID that is not a UUID', () => {
    expect(() => validateRunContext({ userUUID: uniqueUUID(), runID: 'run-1' })).toThrow('Invalid run ID');
  });
});

describe('logs', () => {
  it('keeps console output in order with the level of each method', async () => {
    const { outcome } = await runCode(`(input) => {
      console.log('log', 1);
      console.info('info');
      console.warn('warn');
      console.error('error');
      console.debug('debug');
      console.dir({ dir: true });
      console.table([1, 2]);
      console.trace('trace');
      console.assert(true, 'not logged');
      console.assert(false, 'assert', 2);
      console.assert(false);
      console.group('group'); console.groupCollapsed('collapsed'); console.groupEnd();
      console.count('count'); console.countReset('count');
      console.time('time'); console.timeLog('time'); console.timeEnd('time');
      console.log(new Error('boom').name, undefined, null, { nested: [1] }, 10n);
      return 'done';
    }`);

    const logs = expectCompleted(outcome).logs;
    expect(logs.map(({ level, message }) => [level, message])).toEqual([
      ['log', 'log 1'],
      ['info', 'info'],
      ['warn', 'warn'],
      ['error', 'error'],
      ['debug', 'debug'],
      ['log', '{"dir":true}'],
      ['log', '[1,2]'],
      ['log', 'trace'],
      ['error', 'assert 2'],
      ['error', 'Assertion failed'],
      ['log', 'Error undefined null {"nested":[1]} 10'],
    ]);
    for (const entry of logs) {
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    }
  });

  it('writes an Error as its stack', async () => {
    const { outcome } = await runCode('(input) => { console.error(new TypeError("bad type")); return null; }');

    const [entry] = expectCompleted(outcome).logs;
    expect(entry.message).toMatch(/^TypeError: bad type\n\s+at /);
  });

  it('keeps entries while the cost stays within 65536, cutting the entry that crosses it', async () => {
    // 61 entries of 1000 characters cost 61 * 1064 = 64904; the 62nd has 632 left, 568 for its message
    const { outcome } = await runCode('(input) => { for (let index = 0; index < 70; index += 1) console.log("a".repeat(1000)); return null; }');

    const completed = expectCompleted(outcome);
    expect(completed.logs).toHaveLength(62);
    expect(completed.logs.slice(0, 61).every((entry) => entry.message.length === 1000)).toBe(true);
    expect(completed.logs[61].message).toBe('a'.repeat(568));
    expect(completed.logs_truncated).toBe(true);
  });

  it('drops an entry that would have no room for its message', async () => {
    // 64 entries of 960 characters cost exactly 65536
    const { outcome } = await runCode('(input) => { for (let index = 0; index < 65; index += 1) console.log("b".repeat(960)); return null; }');

    const completed = expectCompleted(outcome);
    expect(completed.logs).toHaveLength(64);
    expect(completed.logs_truncated).toBe(true);
  });

  it('keeps at most 1000 entries, even of empty messages', async () => {
    const { outcome } = await runCode('(input) => { for (let index = 0; index < 5000; index += 1) console.log(""); return null; }');

    const completed = expectCompleted(outcome);
    expect(completed.logs).toHaveLength(1000);
    expect(completed.logs_truncated).toBe(true);
  });

  it('is not truncated at exactly 1000 entries', async () => {
    const { outcome } = await runCode('(input) => { for (let index = 0; index < 1000; index += 1) console.log(""); return null; }');

    const completed = expectCompleted(outcome);
    expect(completed.logs).toHaveLength(1000);
    expect(completed.logs_truncated).toBe(false);
  });

  it('replaces NUL and unpaired surrogates', async () => {
    const { outcome } = await runCode('(input) => { console.log("a\\u0000b", "\\ud800"); return "ok"; }');

    expect(expectCompleted(outcome).logs[0].message).toBe('a�b �');
  });

  it('keeps the logs of two runs at the same time apart', async () => {
    const userUUID = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({
      code: `async (input) => {
        for (let index = 0; index < 5; index += 1) {
          console.log(input.name, index);
          await new Promise((resolve) => setTimeout(resolve, input.delay));
        }
        return input.name;
      }`,
    }));
    const dependencies = createTestDependencies();

    const [first, second] = await Promise.all([
      runCrawler(dependencies, crawler.id, { name: 'first', delay: 3 }, { userUUID }),
      runCrawler(dependencies, crawler.id, { name: 'second', delay: 5 }, { userUUID }),
    ]);

    expect(expectCompleted(first).logs.map((entry) => entry.message)).toEqual(['first 0', 'first 1', 'first 2', 'first 3', 'first 4']);
    expect(expectCompleted(second).logs.map((entry) => entry.message)).toEqual(['second 0', 'second 1', 'second 2', 'second 3', 'second 4']);
  });

  it('adds the stack of a failure at the end of the logs', async () => {
    const { outcome } = await runCode('(input) => { console.log("before"); throw new Error("broke"); }');

    const failed = expectFailed(outcome);
    expect(failed.logs).toHaveLength(2);
    expect(failed.logs[0]).toMatchObject({ level: 'log', message: 'before' });
    expect(failed.logs[1].level).toBe('error');
    expect(failed.logs[1].message).toMatch(/^Error: broke\n\s+at /);
  });

  it('adds the stack even when the logs are full, cut to 4000 characters', async () => {
    const { outcome } = await runCode('(input) => { for (let index = 0; index < 1000; index += 1) console.log(""); throw new Error("y".repeat(5000)); }');

    const failed = expectFailed(outcome);
    expect(failed.logs).toHaveLength(1001);
    expect(failed.logs[1000].message).toBe(`Error: ${'y'.repeat(3993)}`);
  });

  it('does not keep what is logged after the result', async () => {
    const { outcome } = await runCode('(input) => { setTimeout(() => console.log("late"), 0); console.log("on time"); return 1; }');

    expect(expectCompleted(outcome).logs.map((entry) => entry.message)).toEqual(['on time']);
  });

  it('cuts the logs again on the host when the code breaks the limits of the runner', async () => {
    // The runner cuts with String.prototype.slice, which the code shares with it
    const { outcome } = await runCode(`(
      String.prototype.slice = function () { return String(this); },
      (input) => { console.log('a'.repeat(300000)); return null; }
    )`);

    const completed = expectCompleted(outcome);
    expect(completed.logs).toHaveLength(1);
    expect(completed.logs[0].message).toBe('a'.repeat(65_536 - 64));
    expect(completed.logs_truncated).toBe(true);
  });

  it('keeps the timestamps of the host when the code replaces Date.prototype.toISOString', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { KEY: 'timestamp-secret-value' });
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: author,
      code: `(input, context) => {
        Date.prototype.toISOString = function () { return context.environment.KEY + 'x'.repeat(1000000); };
        console.log('first');
        console.log('second');
        return null;
      }`,
    }));
    const before = Date.now();

    const outcome = expectCompleted(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author }));

    expect(outcome.logs.map((entry) => entry.message)).toEqual(['first', 'second']);
    for (const entry of outcome.logs) {
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(entry.timestamp)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(entry.timestamp)).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expect(JSON.stringify(outcome)).not.toContain('timestamp-secret-value');
  });
});

describe('the answer of the runner', () => {
  const TIMESTAMP = '2026-10-13T01:02:03.456Z';

  /** A LOADER whose runner answers as it is told, as a runner the code broke could */
  function answeringLoader(answer: unknown): WorkerLoader {
    return {
      get: () => ({
        getEntrypoint: () => ({
          run: async () => answer,
        }),
      }) as unknown as WorkerStub,
    };
  }

  async function runAnswer(answer: unknown) {
    return (await runCode('(input) => null', {}, { dependencies: createTestDependencies({ loader: answeringLoader(answer) }) })).outcome;
  }

  function entries(count: number, message = ''): unknown[] {
    return Array.from({ length: count }, () => ({ level: 'log', message, timestamp: TIMESTAMP }));
  }

  it('is cut to 1000 entries on the host', async () => {
    const outcome = expectCompleted(await runAnswer({ ok: true, resultJSON: 'null', logs: entries(1500), logsTruncated: false }));

    expect(outcome.logs).toHaveLength(1000);
    expect(outcome.logs_truncated).toBe(true);
  });

  it('is cut to a cost of 65536 on the host', async () => {
    const outcome = expectCompleted(await runAnswer({ ok: true, resultJSON: 'null', logs: entries(3, 'c'.repeat(40_000)), logsTruncated: false }));

    expect(outcome.logs.map((entry) => entry.message.length)).toEqual([40_000, 65_536 - 128 - 40_000]);
    expect(outcome.logs_truncated).toBe(true);
  });

  it('keeps the stack of a failure outside the limits, cut to 4000 characters on the host', async () => {
    const stack = { level: 'error', message: `Error: ${'s'.repeat(10_000)}`, timestamp: TIMESTAMP };
    const outcome = expectFailed(await runAnswer({
      ok: false,
      timedOut: false,
      errorMessage: 'broke',
      logs: [...entries(1000), stack],
      logsTruncated: false,
    }));

    expect(outcome.logs).toHaveLength(1001);
    expect(outcome.logs[1000]).toEqual({ level: 'error', message: `Error: ${'s'.repeat(3993)}`, timestamp: TIMESTAMP });
    expect(outcome.logs_truncated).toBe(true);
  });

  it('does not keep a last entry outside the limits when the run did not fail', async () => {
    const outcome = expectFailed(await runAnswer({
      ok: false,
      timedOut: true,
      errorMessage: '',
      logs: [...entries(1000), { level: 'error', message: 'late', timestamp: TIMESTAMP }],
      logsTruncated: false,
    }));

    expect(outcome.error_code).toBe('execution_timeout');
    expect(outcome.logs).toHaveLength(1000);
    expect(outcome.logs_truncated).toBe(true);
  });

  it('keeps a timestamp only in the form YYYY-MM-DDTHH:MM:SS.sssZ and gives the others the time of the host', async () => {
    const timestamps = [
      TIMESTAMP,
      '2026-10-13T01:02:03Z',
      '2026-10-13T01:02:03.456+00:00',
      '+002026-10-13T01:02:03.456Z',
      '2026-13-40T01:02:03.456Z',
      ' 2026-10-13T01:02:03.456Z',
      `2026-10-13T01:02:03.456Z${'x'.repeat(100)}`,
      42,
      undefined,
    ];
    const before = Date.now();

    const outcome = expectCompleted(await runAnswer({
      ok: true,
      resultJSON: 'null',
      logs: timestamps.map((timestamp, index) => ({ level: 'log', message: String(index), timestamp })),
      logsTruncated: false,
    }));

    expect(outcome.logs.map((entry) => entry.message)).toEqual(timestamps.map((_timestamp, index) => String(index)));
    expect(outcome.logs[0].timestamp).toBe(TIMESTAMP);
    for (const entry of outcome.logs.slice(1)) {
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(entry.timestamp)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(entry.timestamp)).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it('keeps only entries of the five levels with a string message', async () => {
    const outcome = expectCompleted(await runAnswer({
      ok: true,
      resultJSON: 'null',
      logs: [
        ...['debug', 'info', 'log', 'warn', 'error'].map((level) => ({ level, message: level, timestamp: TIMESTAMP })),
        { level: 'fatal', message: 'fatal', timestamp: TIMESTAMP },
        { level: 'log', message: 42, timestamp: TIMESTAMP },
        { level: 'log', timestamp: TIMESTAMP },
        null,
        'log',
      ],
      logsTruncated: false,
    }));

    expect(outcome.logs.map((entry) => entry.message)).toEqual(['debug', 'info', 'log', 'warn', 'error']);
  });
});

describe('time', () => {
  it('ends a run that waits too long with the logs so far', async () => {
    const dependencies = createTestDependencies({ timeouts: { runnerMilliseconds: 50, hostMilliseconds: 5_000 } });
    const { outcome } = await runCode(
      'async (input) => { console.log("waiting"); await new Promise((resolve) => setTimeout(resolve, 2000)); console.log("never"); return 1; }',
      {},
      { dependencies },
    );

    expect(expectFailed(outcome)).toMatchObject({
      error_code: 'execution_timeout',
      error: 'CodeRunner error 422: [execution_timeout] Code execution timed out after 50ms',
      error_description: 'Code execution timed out after 50ms',
      logs: [expect.objectContaining({ level: 'log', message: 'waiting' })],
    });
  });

  it('ends the run on the host side without logs when the runner does not answer', async () => {
    const dependencies = createTestDependencies({ timeouts: { runnerMilliseconds: 5_000, hostMilliseconds: 50 } });
    const { outcome } = await runCode(
      'async (input) => { console.log("waiting"); await new Promise((resolve) => setTimeout(resolve, 1000)); return 1; }',
      {},
      { dependencies },
    );

    expect(expectFailed(outcome)).toMatchObject({
      error_code: 'execution_timeout',
      error: 'CodeRunner error 422: [execution_timeout] Code execution timed out after 5000ms',
      logs: [],
    });
  });

  it('classifies the CPU limit errors of the runtime', () => {
    expect(isCPULimitError('Worker exceeded CPU time limit.')).toBe(true);
    expect(isCPULimitError('Error: exceeded CPU')).toBe(true);
    expect(isCPULimitError('CPU TIME LIMIT reached')).toBe(true);
    expect(isCPULimitError('Network connection lost.')).toBe(false);
  });

  it('turns the CPU limit into execution_timeout', async () => {
    const loader: WorkerLoader = {
      get: () => ({
        getEntrypoint: () => ({
          run: () => Promise.reject(new Error('Worker exceeded CPU time limit.')),
        }),
      }) as unknown as WorkerStub,
    };
    const { outcome } = await runCode('(input) => { for (;;) {} }', {}, { dependencies: createTestDependencies({ loader }) });

    expect(expectFailed(outcome)).toMatchObject({
      error_code: 'execution_timeout',
      error: 'CodeRunner error 422: [execution_timeout] Code execution timed out: CPU time limit of 30000ms exceeded',
      error_description: 'Code execution timed out: CPU time limit of 30000ms exceeded',
      logs: [],
    });
  });

  it('loads a CommonJS crawler module with the CPU limit and the runner as main module', async () => {
    const { loader, calls } = createRecordingLoader();
    const code = `(input) => "loaded ${uniqueUUID()}"`;
    const { outcome } = await runCode(code, {}, { dependencies: createTestDependencies({ loader }) });

    expectCompleted(outcome);
    expect(calls).toHaveLength(1);
    const { workerCode } = calls[0];
    expect(workerCode.limits).toEqual({ cpuMs: 30_000 });
    expect(workerCode.compatibilityDate).toBe('2025-11-25');
    expect(workerCode.compatibilityFlags).toEqual(['nodejs_als']);
    expect(workerCode.mainModule).toBe('runner.js');
    expect(workerCode.modules['runner.js']).toBe(RUNNER_MODULE_SOURCE);
    expect(workerCode.modules['crawler.js']).toEqual({ cjs: `module.exports = (\n${code}\n);` });
    expect(workerCode.env).toEqual({});
    expect(workerCode.globalOutbound).toBeDefined();
    expect(workerCode.globalOutbound).not.toBeNull();
  });
});

describe('isolate IDs', () => {
  it('differ between users for the same code', async () => {
    const first = await createIsolateID(uniqueUUID(), CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input');
    const second = await createIsolateID(uniqueUUID(), CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input');

    expect(first).not.toBe(second);
  });

  it('are the same for the same user and code', async () => {
    const userUUID = uniqueUUID();

    const first = await createIsolateID(userUUID, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input');
    const second = await createIsolateID(userUUID, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input');

    expect(first).toBe(second);
    expect(first).toMatch(new RegExp(`^crawler:${userUUID}:[0-9a-f]{64}$`));
  });

  it('change with the code, the runner module and the options', async () => {
    const userUUID = uniqueUUID();
    const base = await createIsolateID(userUUID, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input');
    const variants = await Promise.all([
      createIsolateID(userUUID, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input + 1'),
      createIsolateID(userUUID, CRAWLER_WORKER_OPTIONS, `${RUNNER_MODULE_SOURCE}\n`, '(input) => input'),
      createIsolateID(userUUID, { ...CRAWLER_WORKER_OPTIONS, limits: { cpuMs: 10_000 } }, RUNNER_MODULE_SOURCE, '(input) => input'),
      createIsolateID(userUUID, { ...CRAWLER_WORKER_OPTIONS, compatibilityDate: '2026-01-01' }, RUNNER_MODULE_SOURCE, '(input) => input'),
      createIsolateID(userUUID, { ...CRAWLER_WORKER_OPTIONS, compatibilityFlags: ['nodejs_als', 'nodejs_compat'] }, RUNNER_MODULE_SOURCE, '(input) => input'),
    ]);

    for (const variant of variants) {
      expect(variant).not.toBe(base);
    }
  });

  it('use none for a run without a user', async () => {
    expect(await createIsolateID(undefined, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, '(input) => input')).toMatch(/^crawler:none:/);
  });

  it('are what a run loads with', async () => {
    const userUUID = uniqueUUID();
    const code = `(input) => "isolate ${uniqueUUID()}"`;
    const { loader, calls } = createRecordingLoader();

    await runCode(code, {}, { userUUID, dependencies: createTestDependencies({ loader }) });

    expect(calls[0].id).toBe(await createIsolateID(userUUID, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, code));
  });
});

describe('environment variables', () => {
  const ENVIRONMENT_CODE = '(input, context) => ({ environment: context.environment, frozen: Object.isFrozen(context.environment) && Object.isFrozen(context) })';

  it('are in context.environment when the user runs a crawler they wrote', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { API_KEY: 'key-value-1234', OTHER: 'other-value' });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code: ENVIRONMENT_CODE }));

    const outcome = expectCompleted(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author }));

    // The values are redacted in the result, so the result shows that they were there
    expect(outcome.result).toEqual({ environment: { API_KEY: '[REDACTED]', OTHER: '[REDACTED]' }, frozen: true });
    const requests = await vaultRequests(author);
    expect(requests).toEqual([
      expect.objectContaining({ route: 'resolve', token: 'test-vault-token', body: { userId: author } }),
    ]);
  });

  it('can be used by name inside the code', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { API_KEY: 'key-value-1234' });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code: '(input, context) => context.environment.API_KEY.length' }));

    expect(expectCompleted(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author })).result).toBe(14);
  });

  it('are empty and the vault is not called for a subscriber', async () => {
    const author = uniqueUUID();
    const subscriber = uniqueUUID();
    await vaultEnvironment(author, { API_KEY: 'key-value-1234' });
    await vaultEnvironment(subscriber, { API_KEY: 'subscriber-value' });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code: ENVIRONMENT_CODE }));

    const outcome = expectCompleted(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: subscriber }));

    expect(outcome.result).toEqual({ environment: {}, frozen: true });
    expect(await vaultRequests(subscriber)).toEqual([]);
    expect(await vaultRequests(author)).toEqual([]);
  });

  it('are empty and the vault is not called for a system crawler', async () => {
    const caller = uniqueUUID();
    await vaultEnvironment(caller, { API_KEY: 'key-value-1234' });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: SYSTEM_USER_UUID, code: ENVIRONMENT_CODE }));

    const outcome = expectCompleted(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: caller }));

    expect(outcome.result).toEqual({ environment: {}, frozen: true });
    expect(await vaultRequests(caller)).toEqual([]);
  });

  it('are empty and the vault is not called without a user', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { API_KEY: 'key-value-1234' });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code: ENVIRONMENT_CODE }));

    const outcome = expectCompleted(await runLoadedCrawler(createTestDependencies(), crawler, {}, undefined));

    expect(outcome.result).toEqual({ environment: {}, frozen: true });
    expect(await vaultRequests(author)).toEqual([]);
  });

  it('are empty in the executeCrawler and executeCrawlerByName RPCs, which do not call the vault', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { API_KEY: 'key-value-1234' });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code: ENVIRONMENT_CODE }));
    const systemCrawler = addCrawler(supabase, crawlerRow({ user_uuid: SYSTEM_USER_UUID, name: 'environment-probe', code: ENVIRONMENT_CODE }));
    const worker = SELF as unknown as Service<typeof CrawlerManagerWorker>;

    await expect(worker.executeCrawler(crawler.id, {})).resolves.toEqual({ type: 'data', result: { environment: {}, frozen: true } });
    await expect(worker.executeCrawlerByName(systemCrawler.name, {})).resolves.toEqual({
      type: 'data',
      result: { environment: {}, frozen: true },
    });
    expect(await vaultRequests(author)).toEqual([]);
  });

  it('throw with the vault status and error code when the vault refuses', async () => {
    const author = uniqueUUID();
    await configureVault(author, { resolve: { status: 503, body: { error: 'vault_unavailable' } } });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author }));
    const dependencies = createTestDependencies();

    await expect(runCrawler(dependencies, crawler.id, {}, { userUUID: author })).rejects.toThrow(
      'Environment variables could not be read: vault responded 503 vault_unavailable',
    );
    expect(dependencies.logger.error).toHaveBeenCalledWith('Environment variables could not be read', undefined, {
      function: 'runCrawler',
      metadata: { crawlerID: crawler.id, userUUID: author, vaultStatus: 503 },
    });
  });

  it('throw when the vault cannot be reached', async () => {
    const author = uniqueUUID();
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author }));
    const unreachable = { fetch: () => Promise.reject(new Error('connection refused')) } as unknown as Fetcher;
    const { UserVaultClient } = await import('../sources/user-vault-client.ts');

    await expect(
      runCrawler(createTestDependencies({ userVaultClient: new UserVaultClient(unreachable, undefined) }), crawler.id, {}, { userUUID: author }),
    ).rejects.toThrow('Environment variables could not be read: vault could not be reached');
  });

  it('throw when the vault answers 401 for a token mismatch', async () => {
    const author = uniqueUUID();
    await configureVault(author, { resolve: { status: 401, body: { error: 'unauthorized' } } });
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author }));

    await expect(runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author })).rejects.toThrow(
      'Environment variables could not be read: vault responded 401 unauthorized',
    );
  });
});

describe('the page of a web crawler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function webCrawler() {
    return addCrawler(supabase, crawlerRow({ type: 'web', url_pattern: '.*', code: '(body) => body.length' }));
  }

  it('is fetched by the Lambda /run with type web, the URL and (body) => body', async () => {
    const page = mockPageBody('12345');
    const crawler = webCrawler();

    const outcome = expectCompleted(await runCrawler(createTestDependencies(), crawler.id, { url: 'https://example.com/a' }, { userUUID: uniqueUUID() }));

    expect(outcome.result).toBe(5);
    expect(page.requests).toEqual([{ type: 'web', mode: 'run', url: 'https://example.com/a', code: '(body) => body' }]);
  });

  it('comes from the URL default of the input schema without a URL in the input', async () => {
    const page = mockPageBody('abc');
    const crawler = addCrawler(supabase, crawlerRow({
      type: 'web',
      url_pattern: '.*',
      code: '(body) => body',
      input_schema: { url: { type: 'string', default: 'https://fallback.example.com/default' } },
    }));

    await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: uniqueUUID() });

    expect(page.requests).toEqual([expect.objectContaining({ url: 'https://fallback.example.com/default' })]);
  });

  it('warns when the URL does not match url_pattern and still runs', async () => {
    mockPageBody('abc');
    const crawler = addCrawler(supabase, crawlerRow({ type: 'web', url_pattern: '^https://only\\.allowed\\.com', code: '(body) => body' }));
    const dependencies = createTestDependencies();

    const outcome = await runCrawler(dependencies, crawler.id, { url: 'https://different.com/page' }, { userUUID: uniqueUUID() });

    expect(expectCompleted(outcome).result).toBe('abc');
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      'URL does not match crawler url_pattern',
      expect.objectContaining({ url: 'https://different.com/page', urlPattern: '^https://only\\.allowed\\.com', crawlerID: crawler.id }),
      { function: 'runCrawler' },
    );
  });

  it('skips the url_pattern check for an unsafe pattern and warns', async () => {
    mockPageBody('abc');
    const crawler = addCrawler(supabase, crawlerRow({ type: 'web', url_pattern: '[invalid(', code: '(body) => body' }));
    const dependencies = createTestDependencies();

    const outcome = await runCrawler(dependencies, crawler.id, { url: 'https://www.example.com/page' }, { userUUID: uniqueUUID() });

    expect(expectCompleted(outcome).result).toBe('abc');
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      'Skipping url_pattern validation: potential ReDoS pattern detected',
      expect.objectContaining({ urlPattern: '[invalid(', crawlerID: crawler.id }),
      expect.objectContaining({ function: 'runCrawler' }),
    );
  });

  it('turns a Lambda 400 into a failed outcome with the same error as before', async () => {
    fetchMock
      .get(CODE_RUNNER_ORIGIN)
      .intercept({ path: '/run', method: 'POST' })
      .reply(400, JSON.stringify({ error: 'invalid_request', error_description: "The resolved address for 'internal' is not allowed" }));
    const crawler = webCrawler();

    const outcome = expectFailed(await runCrawler(createTestDependencies(), crawler.id, { url: 'https://internal/' }, { userUUID: uniqueUUID() }));

    expect(outcome).toEqual({
      status: 'failed',
      type: 'web',
      error_code: 'execution_error',
      error: "CodeRunner error 400: [execution_error] The resolved address for 'internal' is not allowed",
      error_description: "The resolved address for 'internal' is not allowed",
      logs: [],
      logs_truncated: false,
    });
  });

  it('turns a Lambda 502 and 504, after the retries, into failed outcomes with the same errors as before', async () => {
    for (const status of [502, 504]) {
      fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' }).reply(status, '{}').times(3);
      const crawler = webCrawler();

      const outcome = expectFailed(await runCrawler(createTestDependencies(), crawler.id, { url: 'https://example.com/' }, { userUUID: uniqueUUID() }));

      expect(outcome).toMatchObject({
        error_code: 'server_error',
        error: `CodeRunner error ${status}: [server_error] Server returned ${status}`,
        error_description: `Server returned ${status}`,
      });
    }
  }, 20_000);

  it('turns a connection failure into a failed outcome with the same error as before', async () => {
    fetchMock.get(CODE_RUNNER_ORIGIN).intercept({ path: '/run', method: 'POST' }).replyWithError(new Error('connection refused')).times(3);
    const crawler = webCrawler();

    const outcome = expectFailed(await runCrawler(createTestDependencies(), crawler.id, { url: 'https://example.com/' }, { userUUID: uniqueUUID() }));

    expect(outcome.error_code).toBe('network_error');
    expect(outcome.error).toMatch(/^CodeRunner error 0: \[network_error\] /);
  }, 20_000);

  it('fails with invalid_response when the Lambda does not answer a string', async () => {
    fetchMock
      .get(CODE_RUNNER_ORIGIN)
      .intercept({ path: '/run', method: 'POST' })
      .reply(200, JSON.stringify({ type: 'web', mode: 'run', result: { not: 'a string' } }));
    const crawler = webCrawler();

    const outcome = expectFailed(await runCrawler(createTestDependencies(), crawler.id, { url: 'https://example.com/' }, { userUUID: uniqueUUID() }));

    expect(outcome).toMatchObject({
      error_code: 'invalid_response',
      error: 'CodeRunner error 502: [invalid_response] Expected the page body as a string',
      error_description: 'Expected the page body as a string',
    });
  });
});
