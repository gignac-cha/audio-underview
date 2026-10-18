import { describe, it, expect, vi } from 'vitest';
import type { CrawlerRow } from '@audio-underview/supabase-connector';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { CodeRunnerExecutionError, type CodeRunnerClient } from '../sources/code-runner-client.ts';
import { runCrawler, runLoadedCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { UserVaultError } from '../sources/user-vault-client.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import {
  type CrawlerLoader,
  SUPABASE_ORIGIN,
  addCrawler,
  crawlerRow,
  createTestDependencies,
  uniqueUUID,
  vaultEnvironment,
} from './runtime-harness.ts';

// Cases of running crawler code that the other run-crawler tests leave out: other forms of result and of
// code, other thrown values, the arguments of console, a web crawler's input and the answers of the code
// runner Lambda, answers of a runner that cannot be trusted, and the isolation between users.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

type Completed = Extract<CrawlerRunOutcome, { status: 'completed' }>;
type Failed = Extract<CrawlerRunOutcome, { status: 'failed' }>;

function completed(outcome: CrawlerRunOutcome): Completed {
  expect(outcome, JSON.stringify(outcome).slice(0, 500)).toMatchObject({ status: 'completed' });
  return outcome as Completed;
}

function failed(outcome: CrawlerRunOutcome): Failed {
  expect(outcome, JSON.stringify(outcome).slice(0, 500)).toMatchObject({ status: 'failed' });
  return outcome as Failed;
}

async function run(
  code: string,
  input: unknown = {},
  options: { crawler?: Partial<CrawlerRow>; userUUID?: string | null; dependencies?: ReturnType<typeof createTestDependencies> } = {},
): Promise<CrawlerRunOutcome> {
  const userUUID = options.userUUID === undefined ? uniqueUUID() : options.userUUID;
  return runLoadedCrawler(
    options.dependencies ?? createTestDependencies(),
    crawlerRow({ code, ...options.crawler }),
    input,
    userUUID === null ? undefined : { userUUID },
  );
}

function messagesOf(outcome: CrawlerRunOutcome): string[] {
  return outcome.logs.map((entry) => entry.message);
}

describe('the result', () => {
  it('turns undefined into null in every form of returning it', async () => {
    for (const code of ['() => undefined', '() => {}', 'async () => {}', '() => () => 1', '() => Symbol("s")']) {
      expect(completed(await run(code)).result, code).toBeNull();
    }
  });

  it('returns what JSON can carry the way JSON.stringify writes it', async () => {
    const outcome = completed(await run('() => ({ date: new Date(0), nan: NaN, nested: [undefined, 1], skipped: undefined, map: new Map([[1, 2]]) })'));

    expect(outcome.result).toEqual({ date: '1970-01-01T00:00:00.000Z', nan: null, nested: [null, 1], map: {} });
  });

  it('names what JSON cannot carry when it fails the run', async () => {
    const bigint = failed(await run('() => ({ n: 10n })'));
    expect(bigint.error_code).toBe('execution_failed');
    expect(bigint.error_description).toMatch(/BigInt/);
    const circular = failed(await run('() => { const a = {}; a.self = a; return a; }'));
    expect(circular.error_code).toBe('execution_failed');
    expect(circular.error_description).toMatch(/circular/i);
  });

  it('keeps the logs of a run whose result cannot be carried', async () => {
    const outcome = failed(await run('() => { console.log("before"); return { n: 10n }; }'));

    expect(messagesOf(outcome)[0]).toBe('before');
  });

  it('carries a result of any JSON type', async () => {
    for (const [code, expected] of [
      ['() => 0', 0],
      ['() => ""', ''],
      ['() => false', false],
      ['() => null', null],
      ['() => [1, [2, [3]]]', [1, [2, [3]]]],
      ['() => "한국어 😀"', '한국어 😀'],
    ] as const) {
      expect(completed(await run(code)).result, code).toEqual(expected);
    }
  });
});

describe('the code', () => {
  it('keeps sloppy mode: undeclared assignment, octal literal, arguments.callee, with and this', async () => {
    const results: Record<string, unknown> = {};
    for (const [name, code] of Object.entries({
      undeclared: '(body) => { counter = 1; return counter; }',
      octal: '(body) => 010',
      callee: '(function (body) { return typeof arguments.callee; })',
      withStatement: '(function (body) { with ({ a: 5 }) { return a; } })',
      sloppyThis: '(function (body) { return typeof this; })',
    })) {
      results[name] = completed(await run(code)).result;
    }

    expect(results).toEqual({ undeclared: 1, octal: 8, callee: 'function', withStatement: 5, sloppyThis: 'object' });
  });

  it('survives a line comment at the end of the code', async () => {
    expect(completed(await run('(input) => input.value // the answer', { value: 3 })).result).toBe(3);
  });

  it('accepts code of exactly 1048576 characters', async () => {
    const prefix = '(input) => input.value // ';
    const code = prefix + 'x'.repeat(1_048_576 - prefix.length);
    expect(code).toHaveLength(1_048_576);

    expect(completed(await run(code, { value: 'big' })).result).toBe('big');
  });

  it('fails code that is not a function with the same error whatever it is', async () => {
    for (const code of ['42', '({ not: "a function" })', '"text"', 'null', 'undefined', '[() => 1]']) {
      const outcome = failed(await run(code));

      expect(outcome, code).toMatchObject({
        type: 'data',
        error_code: 'execution_failed',
        error: 'CodeRunner error 422: [execution_failed] Crawler code must evaluate to a function',
        error_description: 'Crawler code must evaluate to a function',
        logs_truncated: false,
      });
      // The runner failed with an Error, so its stack is the only entry
      expect(outcome.logs.map((entry) => entry.level), code).toEqual(['error']);
    }
  });

  it('fails a syntax error as execution_failed with no logs', async () => {
    for (const code of ['(input) => {', ') (', 'const a = 1; (x) => a', '(input) => input +']) {
      const outcome = failed(await run(code));
      expect(outcome.error_code, code).toBe('execution_failed');
      expect(outcome.error, code).toMatch(/^CodeRunner error 422: \[execution_failed\] /);
      expect(outcome.logs, code).toEqual([]);
    }
  });

  it('does not run the code of a user in the isolate of another, so state left behind is not seen', async () => {
    const code = `() => {
      globalThis.visits = (globalThis.visits ?? 0) + 1;
      return globalThis.visits;
    }`;
    const user = uniqueUUID();
    const other = uniqueUUID();

    const own = [completed(await run(code, {}, { userUUID: user })).result, completed(await run(code, {}, { userUUID: user })).result];
    const another = completed(await run(code, {}, { userUUID: other })).result;

    expect(own[1]).toBeGreaterThanOrEqual(own[0] as number);
    expect(another).toBe(1);
  });
});

describe('a thrown value', () => {
  it('is described by its message when it is an Error and by its text otherwise', async () => {
    const cases: [string, string][] = [
      ['() => { throw new TypeError("bad type"); }', 'bad type'],
      ['() => { throw "plain text"; }', 'plain text'],
      ['() => { throw { a: 1 }; }', '[object Object]'],
      ['() => { throw null; }', 'null'],
      ['() => { throw undefined; }', 'undefined'],
      ['() => { throw 42; }', '42'],
      ['() => { throw Symbol("tag"); }', 'Symbol(tag)'],
      ['async () => { await null; throw new RangeError("async boom"); }', 'async boom'],
      ['() => Promise.reject(new Error("rejected"))', 'rejected'],
      ['() => Promise.reject("rejected text")', 'rejected text'],
    ];
    for (const [code, description] of cases) {
      const outcome = failed(await run(code));
      expect(outcome.error_description, code).toBe(description);
      expect(outcome.error, code).toBe(`CodeRunner error 422: [execution_failed] ${description}`);
    }
  });

  it('adds a stack to the logs for an Error only, not for text or an Error without a stack', async () => {
    const text = failed(await run('() => { console.log("x"); throw "text"; }'));
    expect(messagesOf(text)).toEqual(['x']);

    const withoutStack = failed(await run('() => { const error = new Error("e"); error.stack = undefined; throw error; }'));
    expect(withoutStack.logs).toEqual([]);
  });
});

describe('console', () => {
  it('logs console.assert only for a false condition', async () => {
    const outcome = completed(await run(`() => {
      console.assert(true, 'not logged');
      console.assert(1, 'not logged either');
      console.assert(false, 'assertion', 'message', 7);
      console.assert(0);
      console.assert(null, { detail: true });
      return null;
    }`));

    expect(outcome.logs.map((entry) => [entry.level, entry.message])).toEqual([
      ['error', 'assertion message 7'],
      ['error', 'Assertion failed'],
      ['error', '{"detail":true}'],
    ]);
  });

  it('ignores group, count and time but logs what is printed inside a group', async () => {
    const outcome = completed(await run(`() => {
      console.group('g'); console.groupCollapsed('gc');
      console.log('inside');
      console.groupEnd();
      console.count('c'); console.countReset('c');
      console.time('t'); console.timeLog('t', 'x'); console.timeEnd('t');
      return null;
    }`));

    expect(messagesOf(outcome)).toEqual(['inside']);
  });

  it('writes the arguments joined by spaces: strings as they are, the rest as JSON, else as text', async () => {
    const outcome = completed(await run(`() => {
      console.log('text', 42, true, null, undefined, { a: [1, 2] }, [3]);
      console.log(10n, Symbol('tag'));
      console.log(() => 1);
      console.log();
      console.log('');
      const circular = {}; circular.self = circular;
      console.log(circular);
      console.log(new Error('with stack'));
      const withoutStack = new Error('no stack'); withoutStack.stack = undefined;
      console.log(withoutStack);
      const emptyStack = new TypeError('empty stack'); emptyStack.stack = '';
      console.log(emptyStack);
      console.log(Object.create(null));
      return null;
    }`));

    const messages = messagesOf(outcome);
    expect(messages[0]).toBe('text 42 true null undefined {"a":[1,2]} [3]');
    expect(messages[1]).toBe('10 Symbol(tag)');
    expect(messages[2]).toBe('() => 1');
    expect(messages[3]).toBe('');
    expect(messages[4]).toBe('');
    expect(messages[5]).toBe('[object Object]');
    expect(messages[6]).toMatch(/^Error: with stack/);
    expect(messages[7]).toBe('Error: no stack');
    expect(messages[8]).toBe('TypeError: empty stack');
    expect(messages[9]).toBe('{}');
  });

  it('cuts at a cost of 65536 counting 64 for each entry, and keeps nothing after the cut', async () => {
    const outcome = completed(await run(`() => {
      console.log('a'.repeat(30000));
      console.log('b'.repeat(30000));
      console.log('c'.repeat(30000));
      console.log('dropped');
      return null;
    }`));

    expect(outcome.logs.map((entry) => entry.message.length)).toEqual([30000, 30000, 5344]);
    expect(outcome.logs.reduce((sum, entry) => sum + entry.message.length + 64, 0)).toBe(65536);
    expect(outcome.logs_truncated).toBe(true);
  });

  it('drops an entry with no room for even one character, and the ones after it, and is not truncated at an exact fit', async () => {
    const dropped = completed(await run(`() => {
      console.log('a'.repeat(65536 - 64 - 64));
      console.log('x');
      console.log('y');
      return null;
    }`));
    expect(dropped.logs).toHaveLength(1);
    expect(dropped.logs[0].message).toHaveLength(65408);
    expect(dropped.logs_truncated).toBe(true);

    const exact = completed(await run(`() => { console.log('a'.repeat(65536 - 64)); return null; }`));
    expect(exact.logs).toHaveLength(1);
    expect(exact.logs_truncated).toBe(false);
  });

  it('cuts the entry after a nearly full log to the room that is left', async () => {
    const outcome = completed(await run(`() => {
      console.log('a'.repeat(65000));
      console.log('b'.repeat(1000));
      console.log('c');
      return null;
    }`));

    // 65536 - (65000 + 64) - 64 = 408 characters of room
    expect(outcome.logs.map((entry) => entry.message.length)).toEqual([65000, 408]);
    expect(outcome.logs_truncated).toBe(true);
  });

  it('does not cut a surrogate pair in half at the limit', async () => {
    const outcome = completed(await run(String.raw`() => {
      console.log('a'.repeat(65536 - 64 - 64 - 1));
      console.log('😀tail');
      return null;
    }`));

    for (const entry of outcome.logs) {
      expect(entry.message.isWellFormed()).toBe(true);
    }
    expect(outcome.logs).toHaveLength(2);
    expect(outcome.logs[1].message).toBe('');
    expect(outcome.logs_truncated).toBe(true);
  });

  it('keeps the unpaired surrogates out of the logs', async () => {
    const outcome = completed(await run(String.raw`() => { console.log('lone \ud800 end'); return null; }`));

    expect(messagesOf(outcome)).toEqual(['lone � end']);
  });

  it('ignores console output made while the module loads', async () => {
    const outcome = completed(await run('(console.log("at load"), (input) => { console.log("in run"); return 1; })'));

    expect(messagesOf(outcome)).toEqual(['in run']);
  });

  it('does not let a late log or an unhandled rejection of one run into the next run of the isolate', async () => {
    const user = uniqueUUID();
    const code = `(input) => {
      if (input.late) {
        setTimeout(() => console.log('late log'), 40);
        Promise.reject(new Error('unhandled'));
        return 'returned';
      }
      return new Promise((resolve) => setTimeout(() => resolve('second run'), 120));
    }`;

    const first = completed(await run(code, { late: true }, { userUUID: user }));
    const second = completed(await run(code, { late: false }, { userUUID: user }));

    expect(first.logs).toEqual([]);
    expect(second.logs).toEqual([]);
    expect(second.result).toBe('second run');
  });

  it('gives every run its own timestamps in order', async () => {
    const outcome = completed(await run(`async () => {
      console.log('one');
      await new Promise((resolve) => setTimeout(resolve, 15));
      console.log('two');
      return null;
    }`));

    const times = outcome.logs.map((entry) => Date.parse(entry.timestamp));
    expect(times).toHaveLength(2);
    expect(times[1]).toBeGreaterThanOrEqual(times[0]);
  });
});

describe('context', () => {
  it('freezes the context and its environment, so the code cannot change them for later reads', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { KEY: 'frozen-key-value-1' });
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: author,
      environment_variable_names: ['KEY'],
      code: `(input, context) => {
        const results = { frozen: Object.isFrozen(context.environment), contextFrozen: Object.isFrozen(context) };
        try { context.environment.KEY = 'changed'; context.environment.ADDED = 'added'; context.files = null; } catch (error) {}
        results.keys = Object.keys(context.environment);
        results.hasFiles = context.files !== null;
        results.fileMethods = Object.keys(context.files);
        return results;
      }`,
    }));

    const outcome = completed(await runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author }));

    expect(outcome.result).toEqual({ frozen: true, contextFrozen: true, keys: ['KEY'], hasFiles: true, fileMethods: ['save', 'read'] });
  });

  it('runs without a user when the caller gives no context at all', async () => {
    const author = uniqueUUID();
    await vaultEnvironment(author, { KEY: 'unused-key-value-1' });
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: author,
      environment_variable_names: ['KEY'],
      code: 'async (input, context) => { let files; try { await context.files.save("x"); files = "saved"; } catch (error) { files = error.message; } return { keys: Object.keys(context.environment), files }; }',
    }));

    const outcome = completed(await runCrawler(createTestDependencies(), crawler.id, {}));

    expect(outcome.result).toEqual({ keys: [], files: 'Files are not available in this run' });
  });
});

describe('the input of a web crawler', () => {
  const webCrawler: Partial<CrawlerRow> = { type: 'web', url_pattern: '.*\\.example\\.com', input_schema: { body: 'string' } };

  function createClient(result: unknown = 'page') {
    const codeRunnerClient = { run: vi.fn(async () => ({ type: 'web' as const, mode: 'run' as const, result })) };
    return { codeRunnerClient, dependencies: createTestDependencies({ codeRunnerClient: codeRunnerClient as CodeRunnerClient }) };
  }

  it('takes the URL of the input before the default of the input schema, and ignores an empty or non-string url', async () => {
    const { codeRunnerClient, dependencies } = createClient();
    const schema = { url: { default: 'https://fallback.example.com/default' } };
    const crawler = { ...webCrawler, input_schema: schema };

    for (const input of [{ url: 'https://www.example.com/given' }, { url: '' }, { url: 42 }, null, undefined, 'text']) {
      await run('(body) => body', input, { crawler, dependencies });
    }

    expect(codeRunnerClient.run.mock.calls.map((call) => call[1])).toEqual([
      'https://www.example.com/given',
      'https://fallback.example.com/default',
      'https://fallback.example.com/default',
      'https://fallback.example.com/default',
      'https://fallback.example.com/default',
      'https://fallback.example.com/default',
    ]);
    expect(codeRunnerClient.run.mock.calls.every((call) => call[0] === 'web' && call[2] === undefined && call[3] === '(body) => body')).toBe(true);
  });

  it('fails invalid_input without a prefix, and without asking the Lambda, for an input that has no URL', async () => {
    const { codeRunnerClient, dependencies } = createClient();
    const crawler = crawlerRow({ ...webCrawler, input_schema: {} });

    for (const input of [{}, null, undefined, 'text', 5]) {
      const outcome = await runLoadedCrawler(dependencies, crawler, input, { userUUID: uniqueUUID() });
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
    }
    expect(codeRunnerClient.run).not.toHaveBeenCalled();
  });

  it('does not warn when the URL matches the url_pattern', async () => {
    const { dependencies } = createClient();

    await run('(body) => body', { url: 'https://www.example.com/page' }, { crawler: webCrawler, dependencies });

    expect(dependencies.logger.warn).not.toHaveBeenCalled();
  });

  it('warns once about a url_pattern that is not a regex and still runs', async () => {
    const { dependencies } = createClient('body text');

    const outcome = await run('(body) => body', { url: 'https://www.example.com/page' }, {
      crawler: { ...webCrawler, url_pattern: '[invalid(' },
      dependencies,
    });

    expect(completed(outcome).result).toBe('body text');
    expect(dependencies.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('accepts an empty page body', async () => {
    const { dependencies } = createClient('');

    expect(completed(await run('(body) => body.length', { url: 'https://www.example.com/page' }, { crawler: webCrawler, dependencies })).result).toBe(0);
  });

  it('does not ask the Lambda for a page of a data crawler', async () => {
    const { codeRunnerClient, dependencies } = createClient();

    await run('(input) => input', { url: 'https://www.example.com/' }, { dependencies });

    expect(codeRunnerClient.run).not.toHaveBeenCalled();
  });
});

describe('the answers of the code runner Lambda', () => {
  const webCrawler: Partial<CrawlerRow> = { type: 'web', url_pattern: '.*', input_schema: { body: 'string' } };

  it('become a failed outcome with the text they have always had, whatever the code', async () => {
    const errors = [
      new CodeRunnerExecutionError('invalid_request', "Field 'url' must be a valid URL", 400),
      new CodeRunnerExecutionError('fetch_failed', 'Failed to fetch the target URL', 502),
      new CodeRunnerExecutionError('fetch_timeout', 'Fetch timed out after 10000ms', 504),
      new CodeRunnerExecutionError('network_error', 'socket hang up', 0),
      new CodeRunnerExecutionError('server_error', 'Server returned 503', 503),
      new CodeRunnerExecutionError('execution_error', 'Code runner returned HTTP 403', 403),
    ];
    for (const error of errors) {
      const codeRunnerClient: CodeRunnerClient = { run: vi.fn().mockRejectedValue(error) };

      const outcome = await run('(body) => body', { url: 'https://www.example.com/page' }, {
        crawler: webCrawler,
        dependencies: createTestDependencies({ codeRunnerClient }),
      });

      expect(outcome).toEqual({
        status: 'failed',
        type: 'web',
        error_code: error.errorCode,
        error: error.message,
        error_description: error.errorDescription,
        logs: [],
        logs_truncated: false,
      });
    }
  });

  it('fail invalid_response when the page is not a string', async () => {
    for (const result of [{ a: 1 }, null, 42, undefined, ['x'], true]) {
      const codeRunnerClient: CodeRunnerClient = { run: vi.fn().mockResolvedValue({ type: 'web', mode: 'run', result }) };

      const outcome = await run('(body) => body', { url: 'https://www.example.com/page' }, {
        crawler: webCrawler,
        dependencies: createTestDependencies({ codeRunnerClient }),
      });

      expect(outcome, JSON.stringify(result)).toEqual({
        status: 'failed',
        type: 'web',
        error_code: 'invalid_response',
        error: 'CodeRunner error 502: [invalid_response] Expected the page body as a string',
        error_description: 'Expected the page body as a string',
        logs: [],
        logs_truncated: false,
      });
    }
  });

  it('throw what is not a failure of the code runner', async () => {
    const codeRunnerClient: CodeRunnerClient = { run: vi.fn().mockRejectedValue(new TypeError('unexpected')) };

    await expect(
      run('(body) => body', { url: 'https://www.example.com/page' }, { crawler: webCrawler, dependencies: createTestDependencies({ codeRunnerClient }) }),
    ).rejects.toThrow('unexpected');
  });

  it('are not asked for before the vault is read', async () => {
    const author = uniqueUUID();
    const codeRunnerClient: CodeRunnerClient = { run: vi.fn() };
    const userVaultClient = { resolveEnvironmentVariables: vi.fn().mockRejectedValue(new UserVaultError(401, 'unauthorized')) };
    const dependencies = createTestDependencies({ codeRunnerClient, userVaultClient: userVaultClient as never });

    await expect(
      runLoadedCrawler(dependencies, crawlerRow({ ...webCrawler, user_uuid: author, code: '(body) => body', environment_variable_names: ['KEY'] }), { url: 'https://www.example.com/' }, { userUUID: author }),
    ).rejects.toThrow('vault responded 401 unauthorized');

    expect(codeRunnerClient.run).not.toHaveBeenCalled();
  });
});

describe('an answer of the runtime that cannot be trusted', () => {
  function answering(answer: unknown): CrawlerLoader {
    return { get: () => ({ getEntrypoint: () => ({ run: async () => answer }) }) as unknown as WorkerStub };
  }

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['text', 'text'],
    ['a number', 42],
    ['ok without a result', { ok: true }],
    ['a result that is not JSON', { ok: true, resultJSON: '{not json', logs: [], logsTruncated: false }],
  ])('fails %s as execution_failed', async (_label, answer) => {
    const outcome = failed(await run('() => 1', {}, { dependencies: createTestDependencies({ loader: answering(answer) }) }));

    expect(outcome.error_code).toBe('execution_failed');
    expect(outcome.logs).toEqual([]);
  });

  it('keeps the logs of a failure whose message is missing, and describes it as unknown', async () => {
    const outcome = failed(await run('() => 1', {}, {
      dependencies: createTestDependencies({
        loader: answering({ ok: false, timedOut: false, logs: [{ level: 'log', message: 'kept', timestamp: '2026-10-13T00:00:00.000Z' }], logsTruncated: false }),
      }),
    }));

    expect(outcome.error_description).toBe('Unknown execution error');
    expect(messagesOf(outcome)).toEqual(['kept']);
  });

  it('ignores logs that are not a list', async () => {
    for (const logs of [undefined, null, 'text', { 0: { level: 'log', message: 'x' } }]) {
      const outcome = completed(await run('() => 1', {}, {
        dependencies: createTestDependencies({ loader: answering({ ok: true, resultJSON: '1', logs, logsTruncated: false }) }),
      }));
      expect(outcome.logs).toEqual([]);
    }
  });

  it('fails any other error of the runtime as execution_failed, once, without running the code again', async () => {
    const run_ = vi.fn(() => Promise.reject(new Error('Dynamic Workers are not enabled')));
    const loader: CrawlerLoader = { get: () => ({ getEntrypoint: () => ({ run: run_ }) }) as unknown as WorkerStub };

    const outcome = failed(await run('() => 1', {}, { dependencies: createTestDependencies({ loader }) }));

    expect(outcome.error_code).toBe('execution_failed');
    expect(outcome.error_description).toBe('Dynamic Workers are not enabled');
    expect(run_).toHaveBeenCalledTimes(1);
  });

  it('describes what the loader throws that is not an Error by its text', async () => {
    const loader = {
      get: () => {
        throw 'a string was thrown';
      },
    } as unknown as WorkerLoader;

    expect(failed(await run('() => 1', {}, { dependencies: createTestDependencies({ loader }) })).error_description).toBe('a string was thrown');
  });

  it('classifies the CPU limit of the runtime as execution_timeout whatever the case of its words', async () => {
    for (const message of ['Worker exceeded CPU time limit.', 'worker exceeded cpu time limit', 'The script exceeded CPU', 'CPU TIME LIMIT']) {
      const loader: CrawlerLoader = { get: () => ({ getEntrypoint: () => ({ run: () => Promise.reject(new Error(message)) }) }) as unknown as WorkerStub };

      const outcome = failed(await run('() => 1', {}, { dependencies: createTestDependencies({ loader }) }));

      expect(outcome.error_code, message).toBe('execution_timeout');
      expect(outcome.error_description, message).toBe('Code execution timed out: CPU time limit of 30000ms exceeded');
    }
    for (const message of ['boom', 'TypeError: x is not a function', 'CPU', 'exceeded memory limit', 'time limit']) {
      const loader: CrawlerLoader = { get: () => ({ getEntrypoint: () => ({ run: () => Promise.reject(new Error(message)) }) }) as unknown as WorkerStub };

      expect(failed(await run('() => 1', {}, { dependencies: createTestDependencies({ loader }) })).error_code, message).toBe('execution_failed');
    }
  });
});
