import { describe, it, expect } from 'vitest';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { runCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import {
  SUPABASE_ORIGIN,
  addCrawler,
  crawlerRow,
  createTestDependencies,
  uniqueUUID,
  vaultEnvironment,
} from './runtime-harness.ts';

// The runner shares its realm with the code of the crawler, so the code can replace the built-ins the runner
// cuts, hides and stamps with. The host must still bound and hide what comes back. These run the real
// LOADER with code that breaks the runner on purpose.

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

const SECRET = 'sk-live-sabotage-secret-value';
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAXIMUM_MESSAGE_LENGTH = 65_536 - 64;

async function runOwn(code: string, environment: Record<string, string> = { KEY: SECRET }): Promise<CrawlerRunOutcome> {
  const author = uniqueUUID();
  await vaultEnvironment(author, environment);
  const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code }));
  return runCrawler(createTestDependencies(), crawler.id, {}, { userUUID: author });
}

function completed(outcome: CrawlerRunOutcome) {
  expect(outcome, JSON.stringify(outcome).slice(0, 500)).toMatchObject({ status: 'completed' });
  return outcome as Extract<CrawlerRunOutcome, { status: 'completed' }>;
}

function failed(outcome: CrawlerRunOutcome) {
  expect(outcome, JSON.stringify(outcome).slice(0, 500)).toMatchObject({ status: 'failed' });
  return outcome as Extract<CrawlerRunOutcome, { status: 'failed' }>;
}

function expectNoSecret(outcome: CrawlerRunOutcome) {
  const text = JSON.stringify(outcome);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET.slice(0, 4));
  expect(text).not.toContain(encodeURIComponent(SECRET));
}

describe('Date.prototype.toISOString replaced by the code', () => {
  it.each([
    ['a number', '() => 42'],
    ['an object', '() => ({ not: "a string" })'],
    ['text that is not a time', '() => "yesterday"'],
    ['an unfinished time', '() => "2026-10-13T01:02:03Z"'],
    ['a time followed by a long text', '() => "2026-10-13T01:02:03.456Z" + "x".repeat(1000000)'],
    ['the value of an environment variable', '(function () { return globalThis.leak; })'],
  ])('gives the logs the time of the host when it answers %s', async (_label, replacement) => {
    const before = Date.now();
    const outcome = completed(await runOwn(`(
      Date.prototype.toISOString = ${replacement},
      (input, context) => {
        globalThis.leak = context.environment.KEY;
        console.log('first');
        console.warn('second ' + context.environment.KEY);
        return null;
      }
    )`));

    expect(outcome.logs.map((entry) => [entry.level, entry.message])).toEqual([['log', 'first'], ['warn', 'second [REDACTED]']]);
    for (const entry of outcome.logs) {
      expect(entry.timestamp).toMatch(TIMESTAMP_PATTERN);
      expect(Date.parse(entry.timestamp)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(entry.timestamp)).toBeLessThanOrEqual(Date.now() + 1000);
    }
    expectNoSecret(outcome);
  });

  it('gives the logs of a failure the time of the host too, and still adds the stack', async () => {
    const outcome = failed(await runOwn(`(
      Date.prototype.toISOString = function () { return 'not a time'; },
      (input, context) => { console.log('before'); throw new Error('broke with ' + context.environment.KEY); }
    )`));

    expect(outcome.error_description).toBe('broke with [REDACTED]');
    expect(outcome.logs).toHaveLength(2);
    expect(outcome.logs[1].message).toMatch(/^Error: broke with \[REDACTED\]\n/);
    for (const entry of outcome.logs) {
      expect(entry.timestamp).toMatch(TIMESTAMP_PATTERN);
    }
    expectNoSecret(outcome);
  });

  it('gives the logs the time of the host when the code replaces Date itself', async () => {
    const outcome = completed(await runOwn(`(
      globalThis.Date = class { toISOString() { return 'not a time'; } },
      (input) => { console.log('stamped by a fake Date'); return null; }
    )`));

    expect(outcome.logs.map((entry) => entry.message)).toEqual(['stamped by a fake Date']);
    expect(outcome.logs[0].timestamp).toMatch(TIMESTAMP_PATTERN);
  });
});

describe('String.prototype.slice replaced by the code', () => {
  it('still cuts a log at the cost limit on the host, with the value hidden before the cut', async () => {
    const outcome = completed(await runOwn(`(
      String.prototype.slice = function () { return String(this); },
      (input, context) => {
        console.log('a'.repeat(${MAXIMUM_MESSAGE_LENGTH - 4}) + context.environment.KEY + 'tail'.repeat(1000));
        return null;
      }
    )`));

    expect(outcome.logs).toHaveLength(1);
    // Four characters of room at the cut: only the start of the marker is left
    expect(outcome.logs[0].message).toBe(`${'a'.repeat(MAXIMUM_MESSAGE_LENGTH - 4)}[RED`);
    expect(outcome.logs_truncated).toBe(true);
    expectNoSecret(outcome);
  });

  it('still cuts the message of a failure at 2000 characters, and keeps its stack within the cost limit', async () => {
    const outcome = failed(await runOwn(`(
      String.prototype.slice = function () { return String(this); },
      (input, context) => { throw new Error('e'.repeat(1996) + context.environment.KEY + 'z'.repeat(10000)); }
    )`));

    expect(outcome.error_description).toBe(`${'e'.repeat(1996)}[RED`);
    expect(outcome.error).toBe(`CodeRunner error 422: [execution_failed] ${'e'.repeat(1996)}[RED`);
    // The host cannot tell the stack from another entry, so it applies the limits of every entry to it
    expect(outcome.logs).toHaveLength(1);
    expect(outcome.logs[0].message.length).toBeLessThanOrEqual(MAXIMUM_MESSAGE_LENGTH);
    expectNoSecret(outcome);
  });

  it('still keeps at most 1000 entries and a cost of 65536 over many logs', async () => {
    const outcome = completed(await runOwn(`(
      String.prototype.slice = function () { return String(this); },
      (input) => { for (let index = 0; index < 700; index += 1) console.log('b'.repeat(2000)); return null; }
    )`));

    const cost = outcome.logs.reduce((sum, entry) => sum + entry.message.length + 64, 0);
    expect(cost).toBeLessThanOrEqual(65_536);
    expect(outcome.logs.length).toBeLessThanOrEqual(1000);
    expect(outcome.logs_truncated).toBe(true);
  });
});

describe('String.prototype.split replaced by the code', () => {
  it('still hides the value in logs, the error and the result, all three forms', async () => {
    const outcome = failed(await runOwn(`(
      String.prototype.split = function () { return [String(this)]; },
      (input, context) => {
        const key = context.environment.KEY;
        console.log('raw ' + key);
        console.log(JSON.stringify({ key }));
        console.log('?key=' + encodeURIComponent(key));
        throw new Error('rejected ' + key);
      }
    )`, { KEY: 'sk-live-"quoted" secret&value' }));

    expect(outcome.error_description).toBe('rejected [REDACTED]');
    expect(outcome.logs.map((entry) => entry.message.split('\n')[0])).toEqual([
      'raw [REDACTED]',
      '{"key":"[REDACTED]"}',
      '?key=[REDACTED]',
      'Error: rejected [REDACTED]',
    ]);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain('secret&value');
    expect(text).not.toContain('secret\\u0026value');
    expect(text).not.toContain(encodeURIComponent('sk-live-"quoted" secret&value'));
  });

  it('still hides the value in the keys and strings of the result', async () => {
    const outcome = completed(await runOwn(`(
      String.prototype.split = function () { return [String(this)]; },
      (input, context) => ({ [context.environment.KEY]: ['x' + context.environment.KEY + 'y'], plain: context.environment.KEY })
    )`));

    expect(outcome.result).toEqual({ '[REDACTED]': ['x[REDACTED]y'], plain: '[REDACTED]' });
    expectNoSecret(outcome);
  });

  it('still bounds and hides together when split and slice are both replaced', async () => {
    const outcome = completed(await runOwn(`(
      String.prototype.slice = function () { return String(this); },
      String.prototype.split = function () { return [String(this)]; },
      (input, context) => {
        console.log('c'.repeat(${MAXIMUM_MESSAGE_LENGTH - 4}) + context.environment.KEY + 'd'.repeat(500000));
        console.log('second ' + context.environment.KEY);
        return { key: context.environment.KEY };
      }
    )`));

    expect(outcome.logs).toHaveLength(1);
    expect(outcome.logs[0].message).toBe(`${'c'.repeat(MAXIMUM_MESSAGE_LENGTH - 4)}[RED`);
    expect(outcome.result).toEqual({ key: '[REDACTED]' });
    expect(outcome.logs_truncated).toBe(true);
    expectNoSecret(outcome);
  });
});

describe('other built-ins replaced by the code', () => {
  it('still replaces NUL characters and unpaired surrogates in the logs on the host', async () => {
    const outcome = completed(await runOwn(`(
      String.prototype.replace = function () { return String(this); },
      String.prototype.toWellFormed = function () { return String(this); },
      (input) => { console.log('a\\u0000b', 'lone \\ud800 end'); return null; }
    )`));

    expect(outcome.logs.map((entry) => entry.message)).toEqual(['a�b lone � end']);
    expect(JSON.stringify(outcome.logs)).not.toContain('\\u0000');
  });

  it('still hides the value and replaces NUL in the message of a failure', async () => {
    const outcome = failed(await runOwn(`(
      String.prototype.replace = function () { return String(this); },
      String.prototype.split = function () { return [String(this)]; },
      (input, context) => { throw new Error('nul\\u0000 and ' + context.environment.KEY); }
    )`));

    expect(outcome.error_description).toBe('nul� and [REDACTED]');
    expectNoSecret(outcome);
  });

  it('still hides the value when String.prototype.includes always says no', async () => {
    const outcome = completed(await runOwn(`(
      String.prototype.includes = function () { return false; },
      (input, context) => { console.log('has ' + context.environment.KEY); return 'has ' + context.environment.KEY; }
    )`));

    expect(outcome.logs.map((entry) => entry.message)).toEqual(['has [REDACTED]']);
    expect(outcome.result).toBe('has [REDACTED]');
    expectNoSecret(outcome);
  });
});

describe('a thrown value that cannot be read', () => {
  it('keeps the message and the logs when only the stack getter throws, and adds no stack', async () => {
    const outcome = failed(await runOwn(`(input) => {
      console.log('before');
      const error = new Error('visible message');
      Object.defineProperty(error, 'stack', { get() { throw new Error('stack getter'); } });
      throw error;
    }`));

    expect(outcome).toMatchObject({ error_code: 'execution_failed', error_description: 'visible message', logs_truncated: false });
    expect(outcome.logs.map((entry) => [entry.level, entry.message])).toEqual([['log', 'before']]);
  });

  it('keeps the logs when only the message getter throws', async () => {
    const outcome = failed(await runOwn(`(input) => {
      console.log('before');
      const error = new Error('hidden');
      Object.defineProperty(error, 'message', { get() { throw new Error('message getter'); } });
      throw error;
    }`));

    expect(outcome.error_code).toBe('execution_failed');
    expect(outcome.error_description).toBe('[object Error]');
    expect(outcome.logs.map((entry) => entry.message.split('\n')[0])).toContain('before');
    expect(outcome.logs.map((entry) => entry.message.split('\n')[0])).toContain('Error: hidden');
  });

  it('describes a thrown object whose toString throws as an object', async () => {
    const outcome = failed(await runOwn(`(input) => {
      console.log('before');
      throw { toString() { throw new Error('toString'); } };
    }`));

    expect(outcome.error_description).toBe('[object Object]');
    expect(outcome.logs.map((entry) => entry.message)).toEqual(['before']);
  });

  it('keeps a stack that is an object instead of a string out of the logs', async () => {
    const outcome = failed(await runOwn(`(input) => {
      const error = new Error('plain');
      Object.defineProperty(error, 'stack', { value: { not: 'a string' } });
      throw error;
    }`));

    expect(outcome.error_description).toBe('plain');
    expect(outcome.logs).toEqual([]);
  });

  it('describes a thrown Error with a circular cause by its message', async () => {
    const outcome = failed(await runOwn(`(input) => {
      const error = new Error('with cause');
      error.cause = error;
      throw error;
    }`));

    expect(outcome.error_description).toBe('with cause');
  });
});

describe('console arguments that cannot be formatted', () => {
  it('writes an object whose toJSON and toString both throw as an object', async () => {
    const outcome = completed(await runOwn(`(input) => {
      console.log('before', { toJSON() { throw new Error('toJSON'); }, toString() { throw new Error('toString'); } }, 'after');
      console.log(Object.create(null, { toJSON: { get() { throw new Error('getter'); } } }));
      return 'done';
    }`));

    expect(outcome.result).toBe('done');
    expect(outcome.logs.map((entry) => entry.message)).toEqual(['before [object Object] after', '[object Object]']);
  });

  it.each([
    [
      'an Error whose stack getter throws',
      `const value = new Error('visible message');
      Object.defineProperty(value, 'stack', { get() { throw new Error('stack getter'); } });`,
      'Error: visible message',
    ],
    [
      'an Error whose name getter throws and that has no stack',
      `const value = new Error('visible message');
      Object.defineProperty(value, 'stack', { value: undefined });
      Object.defineProperty(value, 'name', { get() { throw new Error('name getter'); } });`,
      'Error: visible message',
    ],
    [
      'an Error whose stack, name and message getters all throw',
      `const value = new Error('hidden');
      for (const key of ['stack', 'name', 'message']) {
        Object.defineProperty(value, key, { get() { throw new Error(key + ' getter'); } });
      }`,
      'Error',
    ],
    [
      'a proxy whose getPrototypeOf trap throws',
      `const value = new Proxy({ shown: 1 }, { getPrototypeOf() { throw new Error('getPrototypeOf trap'); } });`,
      '{"shown":1}',
    ],
    [
      'a revoked proxy',
      `const { proxy: value, revoke } = Proxy.revocable({}, {});
      revoke();`,
      '[unprintable]',
    ],
  ])('writes %s without throwing into the code, and keeps the other entries', async (_label, setup, expected) => {
    const outcome = completed(await runOwn(`(input) => {
      ${setup}
      console.log('before');
      console.log('with', value, 'around');
      console.warn(value);
      console.log('after');
      return 'done';
    }`));

    expect(outcome.result).toBe('done');
    expect(outcome.logs.map((entry) => [entry.level, entry.message])).toEqual([
      ['log', 'before'],
      ['log', `with ${expected} around`],
      ['warn', expected],
      ['log', 'after'],
    ]);
  });
});

describe('a result with NUL characters', () => {
  it('keeps the NUL in the result, which only the logs have replaced', async () => {
    const outcome = completed(await runOwn(`(input) => {
      console.log('log with \\u0000 nul');
      return { text: 'a\\u0000b', ['key\\u0000']: ['\\u0000'] };
    }`));

    // Postgres JSONB refuses \\u0000, so recording this run fails (see the direct run route); the logs do not
    expect(outcome.result).toEqual({ text: 'a\u0000b', 'key\u0000': ['\u0000'] });
    expect(outcome.logs.map((entry) => entry.message)).toEqual(['log with � nul']);
  });
});
