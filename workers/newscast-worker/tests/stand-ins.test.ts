import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

// The stand-in workers of vitest.config.ts, used the way their comments describe

interface CrawlerManagerBinding extends Fetcher {
  executeCrawlerByName(name: string, input: unknown): Promise<unknown>;
}

interface TaskGroupReportsBinding extends Fetcher {
  reportProgress(stageRunID: string, progress: unknown): Promise<{ accepted: boolean }>;
  complete(stageRunID: string, output: unknown): Promise<{ accepted: boolean }>;
  fail(stageRunID: string, errorMessage: string): Promise<{ accepted: boolean }>;
}

const bindings = env as unknown as {
  USER_VAULT: Fetcher;
  CRAWLER_MANAGER: CrawlerManagerBinding;
  SCHEDULER_TASK_GROUP_REPORTS: TaskGroupReportsBinding;
  VAULT_INTERNAL_TOKEN: string;
};

async function post(binding: Fetcher, path: string, body: unknown): Promise<Response> {
  return binding.fetch(`https://stand-in.example.com${path}`, { method: 'POST', body: JSON.stringify(body) });
}

describe('user vault stand-in', () => {
  it('answers the configured route of a user and records the request with its token', async () => {
    const user = crypto.randomUUID();
    await post(bindings.USER_VAULT, '/__test__/configure', {
      userId: user,
      responses: { 'keys/status': { status: 200, body: { keys: [] } } },
    });

    const response = await bindings.USER_VAULT.fetch('https://user-vault.internal/internal/keys/status', {
      method: 'POST',
      headers: { 'x-user-vault-token': bindings.VAULT_INTERNAL_TOKEN },
      body: JSON.stringify({ userId: user }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [] });
    const requests = await (await bindings.USER_VAULT.fetch(`https://stand-in.example.com/__test__/requests?userId=${user}`)).json();
    expect(requests).toEqual([
      { userId: user, route: 'keys/status', method: 'POST', token: 'test-vault-token', body: { userId: user } },
    ]);
  });

  it('answers a proxy request by the most specific rule, and a list of answers in order', async () => {
    const user = crypto.randomUUID();
    await post(bindings.USER_VAULT, '/__test__/configure', {
      userId: user,
      responses: {
        proxy: { status: 404, body: { ok: false, error: 'no_key' } },
        'proxy:google': [
          { status: 200, body: { ok: true, status: 429 } },
          { status: 200, body: { ok: true, status: 200 } },
        ],
      },
    });
    const proxy = async (provider: string) => {
      const response = await bindings.USER_VAULT.fetch('https://user-vault.internal/internal/proxy', {
        method: 'POST',
        body: JSON.stringify({ userId: user, provider, path: '/v1/models' }),
      });
      return { status: response.status, body: await response.json() };
    };

    expect(await proxy('google')).toEqual({ status: 200, body: { ok: true, status: 429 } });
    expect(await proxy('google')).toEqual({ status: 200, body: { ok: true, status: 200 } });
    expect(await proxy('google')).toEqual({ status: 200, body: { ok: true, status: 200 } });
    expect(await proxy('openai')).toEqual({ status: 404, body: { ok: false, error: 'no_key' } });
  });

  it('fails a request when the answer is unreachable, and answers 500 to a user without answers', async () => {
    const user = crypto.randomUUID();
    await post(bindings.USER_VAULT, '/__test__/configure', {
      userId: user,
      responses: { proxy: { status: 'unreachable' } },
    });

    await expect(
      bindings.USER_VAULT.fetch('https://user-vault.internal/internal/proxy', { method: 'POST', body: JSON.stringify({ userId: user }) }),
    ).rejects.toThrow();
    const unconfigured = await bindings.USER_VAULT.fetch('https://user-vault.internal/internal/proxy', {
      method: 'POST',
      body: JSON.stringify({ userId: crypto.randomUUID() }),
    });
    expect(unconfigured.status).toBe(500);
  });
});

describe('crawler manager stand-in', () => {
  it('resolves to the answer of the crawler and records the call', async () => {
    const url = `https://example.com/${crypto.randomUUID()}`;
    await post(bindings.CRAWLER_MANAGER, '/__test__/configure', {
      name: 'article-content',
      input: { url },
      answer: { value: { type: 'web', result: 'The article' } },
    });

    await expect(bindings.CRAWLER_MANAGER.executeCrawlerByName('article-content', { url })).resolves.toEqual({
      type: 'web',
      result: 'The article',
    });
    const calls = (await (await bindings.CRAWLER_MANAGER.fetch('https://stand-in.example.com/__test__/calls?name=article-content')).json()) as Array<{
      name: string;
      input: { url: string };
    }>;
    expect(calls.filter((call) => call.input.url === url)).toEqual([{ name: 'article-content', input: { url } }]);
  });

  it('prefers a rule with an input over a rule without, and rejects with the message of an error answer', async () => {
    const name = `crawler-${crypto.randomUUID()}`;
    await post(bindings.CRAWLER_MANAGER, '/__test__/configure', { name, answer: { value: 'any input' } });
    await post(bindings.CRAWLER_MANAGER, '/__test__/configure', { name, input: { url: 'https://example.com/broken' }, answer: { error: '[execution_failed] broken' } });

    await expect(bindings.CRAWLER_MANAGER.executeCrawlerByName(name, { url: 'https://example.com/fine' })).resolves.toBe('any input');
    await expect(() => bindings.CRAWLER_MANAGER.executeCrawlerByName(name, { url: 'https://example.com/broken' })).rejects.toThrow('[execution_failed] broken');
  });

  it('rejects a call that no rule matches', async () => {
    const name = `crawler-${crypto.randomUUID()}`;

    await expect(() => bindings.CRAWLER_MANAGER.executeCrawlerByName(name, {})).rejects.toThrow(`No answer configured for crawler '${name}'`);
  });
});

describe('scheduler manager stand-in', () => {
  async function callsOf(stageRunID: string): Promise<unknown> {
    const response = await bindings.SCHEDULER_TASK_GROUP_REPORTS.fetch(`https://stand-in.example.com/__test__/calls?stageRunID=${stageRunID}`);
    return response.json();
  }

  it('records reportProgress, complete and fail of a stage run and accepts them', async () => {
    const stageRunID = crypto.randomUUID();
    const reports = bindings.SCHEDULER_TASK_GROUP_REPORTS;

    await expect(reports.reportProgress(stageRunID, { message: '1 of 2 newscasts finished', completed: 1, total: 2 })).resolves.toEqual({ accepted: true });
    await expect(reports.complete(stageRunID, { newscasts: [] })).resolves.toEqual({ accepted: true });
    await expect(reports.fail(stageRunID, 'All 2 newscasts failed')).resolves.toEqual({ accepted: true });

    expect(await callsOf(stageRunID)).toEqual([
      { method: 'reportProgress', stageRunID, progress: { message: '1 of 2 newscasts finished', completed: 1, total: 2 } },
      { method: 'complete', stageRunID, output: { newscasts: [] } },
      { method: 'fail', stageRunID, errorMessage: 'All 2 newscasts failed' },
    ]);
  });

  it('answers what the test configures for a stage run, and only for that stage run', async () => {
    const stageRunID = crypto.randomUUID();
    await post(bindings.SCHEDULER_TASK_GROUP_REPORTS, '/__test__/configure', {
      stageRunID,
      answers: { complete: [{ error: 'instance unreachable' }, { accepted: false }], fail: { error: 'bad arguments', typeError: true } },
    });
    const reports = bindings.SCHEDULER_TASK_GROUP_REPORTS;

    await expect(() => reports.complete(stageRunID, {})).rejects.toThrow('instance unreachable');
    await expect(reports.complete(stageRunID, {})).resolves.toEqual({ accepted: false });
    await expect(() => reports.fail(stageRunID, 'message')).rejects.toThrow(TypeError);
    await expect(reports.complete(crypto.randomUUID(), {})).resolves.toEqual({ accepted: true });
  });
});
