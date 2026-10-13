import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { Logger } from '@audio-underview/logger';
import type { CrawlerRunOutcome } from '@audio-underview/worker-tools';
import { createRedactor } from '../sources/crawler-runtime/redaction.ts';
import { runCrawler } from '../sources/crawler-runtime/run-crawler.ts';
import type CrawlerManagerWorker from '../sources/index.ts';
import { useInMemorySupabase } from './in-memory-supabase.ts';
import {
  SUPABASE_ORIGIN,
  addCrawler,
  crawlerRow,
  createTestDependencies,
  uniqueUUID,
  vaultEnvironment,
} from './runtime-harness.ts';

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

const SECRET = 'sk-live-"quoted"/value?&=1';
const SECRET_JSON_FORM = JSON.stringify(SECRET).slice(1, -1);
const SECRET_URL_FORM = encodeURIComponent(SECRET);

describe('createRedactor', () => {
  it('hides a value as it is, inside a JSON string and URL-encoded', () => {
    const { redactText } = createRedactor({ KEY: SECRET });

    expect(redactText(`plain ${SECRET} end`)).toBe('plain [REDACTED] end');
    expect(redactText(`json ${JSON.stringify({ key: SECRET })}`)).toBe('json {"key":"[REDACTED]"}');
    expect(redactText(`url https://api.example.com/?key=${SECRET_URL_FORM}`)).toBe('url https://api.example.com/?key=[REDACTED]');
  });

  it('hides a longer value first, so a value that contains another is hidden whole', () => {
    const { redactText } = createRedactor({ SHORT: 'abcd', LONG: 'abcdefgh' });

    expect(redactText('abcdefgh abcd')).toBe('[REDACTED] [REDACTED]');
  });

  it('hides values in strings, array items and object keys, recursively', () => {
    const { redactValue } = createRedactor({ KEY: 'secret-value' });

    expect(redactValue({
      text: 'a secret-value b',
      list: ['secret-value', 1, null, true, { 'secret-value': 'secret-value' }],
      number: 7,
    })).toEqual({
      text: 'a [REDACTED] b',
      list: ['[REDACTED]', 1, null, true, { '[REDACTED]': '[REDACTED]' }],
      number: 7,
    });
  });

  it('keeps a __proto__ key an ordinary property', () => {
    const { redactValue } = createRedactor({ KEY: 'secret-value' });
    const value = JSON.parse('{"__proto__":{"polluted":"secret-value"}}');

    const redacted = redactValue(value) as Record<string, unknown>;
    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(redacted, '__proto__')?.value).toEqual({ polluted: '[REDACTED]' });
  });

  it('hides values in log messages', () => {
    const { redactLogs } = createRedactor({ KEY: 'secret-value' });

    expect(redactLogs([{ level: 'log', message: 'x secret-value', timestamp: 't', item_index: 1 }])).toEqual([
      { level: 'log', message: 'x [REDACTED]', timestamp: 't', item_index: 1 },
    ]);
  });

  it('returns the input as it is without values', () => {
    const { redactText, redactValue } = createRedactor({});
    const value = { a: ['b'] };

    expect(redactText('text')).toBe('text');
    expect(redactValue(value)).toBe(value);
  });
});

describe('redaction of a run', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runOwnCrawler(code: string, environment: Record<string, string>, input: unknown = {}): Promise<CrawlerRunOutcome> {
    const author = uniqueUUID();
    await vaultEnvironment(author, environment);
    const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author, code }));
    return runCrawler(createTestDependencies(), crawler.id, input, { userUUID: author });
  }

  it('hides values in logs, result strings and result keys', async () => {
    const outcome = await runOwnCrawler(
      `(input, context) => {
        const key = context.environment.KEY;
        console.log('the key is', key);
        console.log(JSON.stringify({ key }));
        console.log('https://api.example.com/?key=' + encodeURIComponent(key));
        return { text: 'key=' + key, [key]: [key, 'other'] };
      }`,
      { KEY: SECRET },
    );

    expect(outcome.status).toBe('completed');
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET_JSON_FORM);
    expect(text).not.toContain(SECRET_URL_FORM);
    expect(outcome.logs.map((entry) => entry.message)).toEqual([
      'the key is [REDACTED]',
      '{"key":"[REDACTED]"}',
      'https://api.example.com/?key=[REDACTED]',
    ]);
    expect(outcome.status === 'completed' && outcome.result).toEqual({ text: 'key=[REDACTED]', '[REDACTED]': ['[REDACTED]', 'other'] });
  });

  it('hides values in the error and its stack', async () => {
    const outcome = await runOwnCrawler(
      '(input, context) => { throw new Error("rejected key " + context.environment.KEY); }',
      { KEY: SECRET },
    );

    expect(outcome.status).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(outcome).toMatchObject({
      error: 'CodeRunner error 422: [execution_failed] rejected key [REDACTED]',
      error_description: 'rejected key [REDACTED]',
    });
    expect(outcome.logs.at(-1)?.message).toMatch(/^Error: rejected key \[REDACTED\]\n/);
  });

  it('hides the longer of two overlapping values first', async () => {
    const outcome = await runOwnCrawler(
      '(input, context) => context.environment.LONG + " " + context.environment.SHORT',
      { SHORT: 'token', LONG: 'token-and-more' },
    );

    expect(outcome.status === 'completed' && outcome.result).toBe('[REDACTED] [REDACTED]');
  });

  it('hides a value before cutting the entry at the limit, so no prefix of it stays', async () => {
    const value = 'v'.repeat(200);
    // 64 entries of 958 characters cost 65408; the last has 128 left, 64 for its message, which would
    // keep the first 64 characters of the value if it were cut before it is hidden
    const outcome = await runOwnCrawler(
      `(input, context) => {
        for (let index = 0; index < 64; index += 1) console.log('x'.repeat(958));
        console.log(context.environment.LONG_VALUE);
        return null;
      }`,
      { LONG_VALUE: value },
    );

    expect(outcome.logs_truncated).toBe(false);
    expect(outcome.logs.at(-1)?.message).toBe('[REDACTED]');
    expect(JSON.stringify(outcome)).not.toContain('v'.repeat(10));
  });

  it('hides a value cut across the limit', async () => {
    const value = 'w'.repeat(200);
    const outcome = await runOwnCrawler(
      `(input, context) => {
        for (let index = 0; index < 64; index += 1) console.log('x'.repeat(958));
        console.log('prefix ' + context.environment.LONG_VALUE + ' suffix'.repeat(20));
        return null;
      }`,
      { LONG_VALUE: value },
    );

    expect(outcome.logs_truncated).toBe(true);
    // 128 left, 64 for the message, counted after the value was hidden
    expect(outcome.logs.at(-1)?.message).toBe(`prefix [REDACTED]${' suffix'.repeat(20)}`.slice(0, 64));
    expect(JSON.stringify(outcome)).not.toContain('w'.repeat(10));
  });

  it('hides a value in the stack before the runner cuts it at 4000 characters, so no prefix of it stays', async () => {
    // "Error: " and 3989 characters leave 4 for the value: a cut before hiding would keep "sk-l"
    const outcome = await runOwnCrawler(
      '(input, context) => { throw new Error("y".repeat(3989) + context.environment.KEY + " end"); }',
      { KEY: SECRET },
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.logs.at(-1)?.message).toBe(`Error: ${'y'.repeat(3989)}[RED`);
    expect(JSON.stringify(outcome)).not.toContain(SECRET.slice(0, 4));
  });

  it('hides a value in the error before the runner cuts it at 2000 characters, so no prefix of it stays', async () => {
    const outcome = await runOwnCrawler(
      '(input, context) => { throw "z".repeat(1996) + context.environment.KEY; }',
      { KEY: SECRET },
    );

    expect(outcome).toMatchObject({ status: 'failed', error_description: `${'z'.repeat(1996)}[RED` });
    expect(JSON.stringify(outcome)).not.toContain(SECRET.slice(0, 4));
  });

  it('hides values on the host when the code stops the runner from hiding them', async () => {
    // The runner hides with String.prototype.split, which the code shares with it
    const outcome = await runOwnCrawler(
      `(
        String.prototype.split = function () { return [String(this)]; },
        (input, context) => {
          console.log('the key is ' + context.environment.KEY);
          throw new Error('rejected key ' + context.environment.KEY);
        }
      )`,
      { KEY: SECRET },
    );

    expect(outcome).toMatchObject({ status: 'failed', error_description: 'rejected key [REDACTED]' });
    expect(outcome.logs[0].message).toBe('the key is [REDACTED]');
    expect(outcome.logs.at(-1)?.message).toMatch(/^Error: rejected key \[REDACTED\]\n/);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET_JSON_FORM);
    expect(text).not.toContain(SECRET_URL_FORM);
  });

  describe('on the host, whatever the runner answers', () => {
    const TIMESTAMP = '2026-10-13T01:02:03.456Z';

    async function runAnswer(answer: unknown): Promise<CrawlerRunOutcome> {
      const author = uniqueUUID();
      await vaultEnvironment(author, { KEY: SECRET });
      const crawler = addCrawler(supabase, crawlerRow({ user_uuid: author }));
      const loader = {
        get: () => ({ getEntrypoint: () => ({ run: async () => answer }) }),
      } as unknown as WorkerLoader;
      return runCrawler(createTestDependencies({ loader }), crawler.id, {}, { userUUID: author });
    }

    it('hides values in the result, the logs and their timestamps', async () => {
      const outcome = await runAnswer({
        ok: true,
        resultJSON: JSON.stringify({ text: `key=${SECRET}`, [SECRET]: [SECRET_URL_FORM] }),
        logs: [
          { level: 'log', message: `the key is ${SECRET}`, timestamp: TIMESTAMP },
          { level: 'info', message: JSON.stringify({ key: SECRET }), timestamp: SECRET },
        ],
        logsTruncated: false,
      });

      expect(outcome.status === 'completed' && outcome.result).toEqual({ text: 'key=[REDACTED]', '[REDACTED]': ['[REDACTED]'] });
      expect(outcome.logs.map((entry) => entry.message)).toEqual(['the key is [REDACTED]', '{"key":"[REDACTED]"}']);
      const text = JSON.stringify(outcome);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECRET_JSON_FORM);
      expect(text).not.toContain(SECRET_URL_FORM);
    });

    it('hides values in the error, the logs and the stack before cutting them, so no prefix of a value stays', async () => {
      const outcome = await runAnswer({
        ok: false,
        timedOut: false,
        // Cut at 2000, the stack at 4000 and the first entry at the cost of 65536: each leaves 4 characters for the value
        errorMessage: `${'x'.repeat(1996)}${SECRET}`,
        logs: [
          { level: 'log', message: `${'l'.repeat(65_536 - 64 - 4)}${SECRET}`, timestamp: TIMESTAMP },
          { level: 'error', message: `Error: ${'y'.repeat(3989)}${SECRET}\n    at crawler`, timestamp: TIMESTAMP },
        ],
        logsTruncated: false,
      });

      expect(outcome).toMatchObject({
        status: 'failed',
        error_code: 'execution_failed',
        error_description: `${'x'.repeat(1996)}[RED`,
        logs_truncated: true,
      });
      expect(outcome.logs.map((entry) => entry.message)).toEqual([
        `${'l'.repeat(65_536 - 64 - 4)}[RED`,
        `Error: ${'y'.repeat(3989)}[RED`,
      ]);
      expect(JSON.stringify(outcome)).not.toContain(SECRET.slice(0, 4));
    });
  });

  it('gives no value to any logger call after a run that failed with it', async () => {
    const calls: unknown[][] = [];
    for (const method of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation(function (this: Logger, ...parts: unknown[]) {
        calls.push(parts);
      });
    }
    const consoleLines: unknown[][] = [];
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        consoleLines.push(parts);
      });
    }
    const author = uniqueUUID();
    await vaultEnvironment(author, { KEY: SECRET });
    const crawler = addCrawler(supabase, crawlerRow({
      user_uuid: author,
      code: '(input, context) => { console.error(context.environment.KEY); throw new Error(context.environment.KEY); }',
    }));
    const worker = SELF as unknown as Service<typeof CrawlerManagerWorker>;

    const outcome = await worker.runCrawler(crawler.id, {}, { userUUID: author });

    expect(outcome.status).toBe('failed');
    expect(calls.length).toBeGreaterThan(0);
    const logged = JSON.stringify([calls, consoleLines], (_key, value) => (value instanceof Error ? `${value.message} ${value.stack}` : value));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(SECRET_JSON_FORM);
    expect(logged).not.toContain(SECRET_URL_FORM);
    expect(calls).toContainEqual(['Crawler run failed', { crawlerID: crawler.id, errorCode: 'execution_failed' }, { function: 'runCrawler' }]);
  });
});
