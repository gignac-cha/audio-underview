import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The three workers this worker is bound to are stood in for by the scripts below. A test reaches each
// through its binding (env.USER_VAULT, env.CRAWLER_MANAGER, env.SCHEDULER_TASK_GROUP_REPORTS from
// cloudflare:test), and configures it and reads what it received with fetch() on that binding, to
// a path under /__test__/ (the host of the URL is ignored). The stand-ins keep their state for as long as
// the test run lives and hold no state per test, so a test uses IDs of its own (a user UUID, a stage run ID,
// a URL) and test files running side by side do not see each other's answers.
//
// An answer can be a list instead: each request takes the next one, and the last one repeats.

// Stands in for user-vault-worker.
//
// POST /__test__/configure { userId, responses: { <route>: <answer> } } sets the answers for a user.
//   <route> is what follows /internal/ in the path: proxy, keys/status, keys/audit, keys/put, keys/delete.
//   For proxy, the more specific "proxy:<provider>" and "proxy:<provider>:<path>" (the provider and the path
//   of the proxied request) win over "proxy".
//   <answer> is { status, body }, which the vault answers as JSON, or { status: 'unreachable' }, which
//   makes the request fail as a vault that is down does.
// GET /__test__/requests?userId=<user> answers the requests the vault received for the user, oldest first, as
//   [{ userId, route, method, token, body }]. token is the x-user-vault-token header.
// A request for a user or a route without an answer gets 500 { error: 'not_configured' }.
const USER_VAULT_SCRIPT = `
const responsesByUser = new Map();
const requests = [];

function takeAnswer(entry) {
  if (!Array.isArray(entry)) return entry;
  return entry.length > 1 ? entry.shift() : entry[0];
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/configure') {
      const { userId, responses } = await request.json();
      responsesByUser.set(userId, responses);
      return Response.json({ configured: true });
    }
    if (url.pathname === '/__test__/requests') {
      const userId = url.searchParams.get('userId');
      return Response.json(requests.filter((entry) => entry.userId === userId));
    }
    let body = null;
    try {
      body = await request.json();
    } catch {}
    const userId = body !== null && typeof body === 'object' ? body.userId : undefined;
    const route = url.pathname.replace('/internal/', '');
    requests.push({ userId, route, method: request.method, token: request.headers.get('x-user-vault-token'), body });
    const responses = responsesByUser.get(userId) ?? {};
    const candidates = route === 'proxy' && body !== null && typeof body === 'object'
      ? ['proxy:' + body.provider + ':' + body.path, 'proxy:' + body.provider, 'proxy']
      : [route];
    const found = candidates.find((candidate) => responses[candidate] !== undefined);
    if (found === undefined) return Response.json({ error: 'not_configured' }, { status: 500 });
    const response = takeAnswer(responses[found]);
    if (response.status === 'unreachable') {
      throw new Error('vault is down');
    }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  },
};
`;

// Stands in for crawler-manager-worker, with the RPC method this worker calls.
//
// POST /__test__/configure { name, input?, answer } adds an answer for executeCrawlerByName(name, input).
//   input is optional: the call matches when every field of it is equal to the same field of the input of the
//   call. A rule with input wins over one without, and a later rule wins over an earlier one.
//   <answer> is { value }, which the call resolves to (what the crawler returns, such as
//   { type: 'data', result: [...] }), or { error: '<message>' }, which makes the call reject with that message.
// GET /__test__/calls?name=<crawler name> answers the calls received, oldest first, as [{ name, input }]
//   (all of them without name).
// POST /__test__/reset forgets every rule and call, for every test file that shares the stand-in.
// A call that no rule matches rejects with "No answer configured for crawler '<name>'".
const CRAWLER_MANAGER_SCRIPT = `
import { WorkerEntrypoint } from 'cloudflare:workers';

const rules = [];
const calls = [];

function takeAnswer(rule) {
  if (!Array.isArray(rule.answer)) return rule.answer;
  return rule.answer.length > 1 ? rule.answer.shift() : rule.answer[0];
}

function matchesInput(rule, input) {
  if (rule.input === undefined) return true;
  if (input === null || typeof input !== 'object') return false;
  return Object.entries(rule.input).every(([key, value]) => JSON.stringify(input[key]) === JSON.stringify(value));
}

export default class CrawlerManagerStandIn extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/configure') {
      const { name, input, answer } = await request.json();
      rules.push({ name, input, answer });
      return Response.json({ configured: true });
    }
    if (url.pathname === '/__test__/calls') {
      const name = url.searchParams.get('name');
      return Response.json(calls.filter((call) => name === null || call.name === name));
    }
    if (url.pathname === '/__test__/reset') {
      rules.length = 0;
      calls.length = 0;
      return Response.json({ reset: true });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  async executeCrawlerByName(name, input) {
    calls.push({ name, input });
    const matching = rules.filter((rule) => rule.name === name && matchesInput(rule, input)).reverse();
    const rule = matching.find((candidate) => candidate.input !== undefined) ?? matching[0];
    if (rule === undefined) throw new Error("No answer configured for crawler '" + name + "'");
    const answer = takeAnswer(rule);
    if (answer.error !== undefined) throw new Error(answer.error);
    return answer.value;
  }
}
`;

// Stands in for scheduler-manager-worker, with the TaskGroupReports entrypoint this worker reports to.
// Each method records its call and answers { accepted: true }, unless the test sets another answer.
//
// POST /__test__/configure { stageRunID, answers: { reportProgress?, complete?, fail? } } sets the answers
//   for a stage run. <answer> is { accepted: false }, or { error: '<message>' }, which makes the call reject
//   with that message (and { error: '<message>', typeError: true } with a TypeError, as the scheduler rejects
//   arguments it cannot use).
// GET /__test__/calls?stageRunID=<stage run> answers the calls received for the stage run, oldest first, as
//   [{ method: 'reportProgress', stageRunID, progress }],
//   [{ method: 'complete', stageRunID, output }] and [{ method: 'fail', stageRunID, errorMessage }].
const SCHEDULER_MANAGER_SCRIPT = `
import { WorkerEntrypoint } from 'cloudflare:workers';

const answersByStageRun = new Map();
const calls = [];

function takeAnswer(entry) {
  if (!Array.isArray(entry)) return entry;
  return entry.length > 1 ? entry.shift() : entry[0];
}

function record(method, stageRunID, details) {
  calls.push({ method, stageRunID, ...details });
  const answer = takeAnswer((answersByStageRun.get(stageRunID) ?? {})[method]);
  if (answer === undefined) return { accepted: true };
  if (answer.error !== undefined) throw answer.typeError === true ? new TypeError(answer.error) : new Error(answer.error);
  return answer;
}

export class TaskGroupReports extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/configure') {
      const { stageRunID, answers } = await request.json();
      answersByStageRun.set(stageRunID, answers);
      return Response.json({ configured: true });
    }
    if (url.pathname === '/__test__/calls') {
      const stageRunID = url.searchParams.get('stageRunID');
      return Response.json(calls.filter((call) => call.stageRunID === stageRunID));
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  async reportProgress(stageRunID, progress) {
    return record('reportProgress', stageRunID, { progress });
  }

  async complete(stageRunID, output) {
    return record('complete', stageRunID, { output });
  }

  async fail(stageRunID, errorMessage) {
    return record('fail', stageRunID, { errorMessage });
  }
}

export default {
  async fetch() {
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
`;

// The date wrangler.toml sets, which the stand-ins need for RPC between workers
const COMPATIBILITY_DATE = '2026-10-12';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: 'https://example.com',
          SUPABASE_URL: 'https://supabase.example.com',
          SUPABASE_SCHEMA: 'test_schema',
          SUPABASE_SECRET_KEY: 'test-secret-key',
          JWT_SECRET: 'test-jwt-secret-key-for-testing-only',
          VAULT_INTERNAL_TOKEN: 'test-vault-token',
        },
        workers: [
          {
            name: 'audio-underview-user-vault-worker',
            compatibilityDate: COMPATIBILITY_DATE,
            modules: true,
            script: USER_VAULT_SCRIPT,
          },
          {
            name: 'audio-underview-crawler-manager-worker',
            compatibilityDate: COMPATIBILITY_DATE,
            modules: true,
            script: CRAWLER_MANAGER_SCRIPT,
          },
          {
            name: 'audio-underview-scheduler-manager-worker',
            compatibilityDate: COMPATIBILITY_DATE,
            modules: true,
            script: SCHEDULER_MANAGER_SCRIPT,
          },
        ],
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['@audio-underview/worker-tools/tests/setup.ts'],
    // The Workers runtime cannot read the module cache Vitest writes to disk
    fsModuleCache: false,
  },
});
