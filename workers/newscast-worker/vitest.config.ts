import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The three workers this worker is bound to are stood in for by the scripts below. A test reaches each
// through its binding (env.USER_VAULT, env.CRAWLER_MANAGER, env.SCHEDULER_TASK_GROUP_REPORTS and
// env.SCHEDULER_MANAGER from cloudflare:test), and configures it and reads what it received with fetch() on
// that binding, to a path under /__test__/ (the host of the URL is ignored). The stand-ins keep their state
// for as long as the test run lives and hold no state per test, so a test uses IDs of its own (a user UUID,
// a stage run ID, a URL) and test files running side by side do not see each other's answers.
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

// Stands in for scheduler-manager-worker, with two parts: the TaskGroupReports entrypoint this worker
// reports to (binding SCHEDULER_TASK_GROUP_REPORTS), and the public HTTP API its default entrypoint serves
// (binding SCHEDULER_MANAGER), which the newscast templates call.
//
// TaskGroupReports: each method records its call and answers { accepted: true }, unless the test sets another
// answer.
//
// POST /__test__/configure { stageRunID, answers: { reportProgress?, complete?, fail? } } sets the answers
//   for a stage run. <answer> is { accepted: false }, or { error: '<message>' }, which makes the call reject
//   with that message (and { error: '<message>', typeError: true } with a TypeError, as the scheduler rejects
//   arguments it cannot use).
// GET /__test__/calls?stageRunID=<stage run> answers the calls received for the stage run, oldest first, as
//   [{ method: 'reportProgress', stageRunID, progress }],
//   [{ method: 'complete', stageRunID, output }] and [{ method: 'fail', stageRunID, errorMessage }].
//
// HTTP API: schedulers and their stages live in memory for the user the Authorization header names (the sub
// of the JWT, which is read and not verified; a request without a Bearer token gets 401). It answers
//   POST /schedulers -> 201 the scheduler (400 without a name)    GET /schedulers/:id -> 200, or 404
//   DELETE /schedulers/:id -> 200 { deleted: true }, or 404       GET /schedulers/:id/stages -> 200 { data }
//   POST /schedulers/:id/stages -> 201 the stage, 404 for a scheduler of another user, 409 for a stage order taken
// A scheduler is { id, user_uuid, name, cron_expression, is_enabled }, and a stage has the fields of the request
// (stage_type 'crawler' when the request names none) plus id, scheduler_id and stage_order.
//
// POST /__test__/configure { userID, failures: { '<METHOD> <route>': <answer> } } makes requests of the user fail.
//   <route> is the path with :id, as in 'POST /schedulers/:id/stages'. <answer> is { status, body? }, which is the
//   answer instead of the normal one, { status: 'unreachable' }, which makes the request fail as a scheduler
//   that is down does, or null, which lets the request through. A list gives each request the next answer, and
//   the last one repeats, so [null, { status: 500 }] fails every request but the first.
// GET /__test__/requests?userID=<user> answers the requests the user made, oldest first, as
//   [{ method, route, schedulerID, authorization, body }]. authorization is the Authorization header as received.
// GET /__test__/schedulers?userID=<user> answers the schedulers of the user with their stages, oldest first.
// POST /__test__/forget { schedulerID } removes a scheduler and its stages, as if the user deleted it elsewhere.
// POST /__test__/remove-stage { stageID } removes a stage from its scheduler.
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

const schedulers = new Map();
const failuresByUser = new Map();
const apiRequests = [];

function subjectOf(request) {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return undefined;
  try {
    const payload = header.slice('Bearer '.length).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).sub;
  } catch {
    return undefined;
  }
}

function jsonAnswer(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function notFound() {
  return jsonAnswer({ error: 'not_found', error_description: 'Scheduler not found' }, 404);
}

function routeOf(method, pathname) {
  let match;
  if (pathname === '/schedulers') return { route: method + ' /schedulers' };
  if ((match = /^\\/schedulers\\/([^/]+)$/.exec(pathname)) !== null) return { route: method + ' /schedulers/:id', schedulerID: match[1] };
  if ((match = /^\\/schedulers\\/([^/]+)\\/stages$/.exec(pathname)) !== null) return { route: method + ' /schedulers/:id/stages', schedulerID: match[1] };
  return { route: method + ' ' + pathname };
}

function withoutStages(scheduler) {
  const { stages, ...fields } = scheduler;
  return fields;
}

async function serveTestRoute(request, url) {
  if (url.pathname === '/__test__/configure') {
    const { userID, failures } = await request.json();
    failuresByUser.set(userID, failures);
    return Response.json({ configured: true });
  }
  if (url.pathname === '/__test__/requests') {
    const userID = url.searchParams.get('userID');
    return Response.json(apiRequests.filter((entry) => entry.user === userID).map(({ user, ...entry }) => entry));
  }
  if (url.pathname === '/__test__/schedulers') {
    const userID = url.searchParams.get('userID');
    return Response.json([...schedulers.values()].filter((scheduler) => scheduler.user_uuid === userID));
  }
  if (url.pathname === '/__test__/forget') {
    const { schedulerID } = await request.json();
    return Response.json({ forgotten: schedulers.delete(schedulerID) });
  }
  if (url.pathname === '/__test__/remove-stage') {
    const { stageID } = await request.json();
    for (const scheduler of schedulers.values()) {
      scheduler.stages = scheduler.stages.filter((stage) => stage.id !== stageID);
    }
    return Response.json({ removed: true });
  }
  return Response.json({ error: 'not_found' }, { status: 404 });
}

async function serveApi(request, url) {
  const user = subjectOf(request);
  const { route, schedulerID } = routeOf(request.method, url.pathname);
  let body = null;
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {}
  }
  apiRequests.push({ user, method: request.method, route, schedulerID, authorization: request.headers.get('authorization'), body });
  if (user === undefined) return jsonAnswer({ error: 'unauthorized', error_description: 'Valid authentication is required' }, 401);

  const failure = takeAnswer((failuresByUser.get(user) ?? {})[route]);
  if (failure !== undefined && failure !== null) {
    if (failure.status === 'unreachable') throw new Error('scheduler is down');
    return jsonAnswer(failure.body ?? { error: 'failed' }, failure.status);
  }

  if (route === 'POST /schedulers') {
    if (body === null || typeof body.name !== 'string' || body.name.trim() === '') {
      return jsonAnswer({ error: 'invalid_request', error_description: "Field 'name' is required and must be a non-empty string" }, 400);
    }
    const scheduler = {
      id: crypto.randomUUID(),
      user_uuid: user,
      name: body.name,
      cron_expression: body.cron_expression ?? null,
      is_enabled: body.is_enabled ?? true,
      stages: [],
    };
    schedulers.set(scheduler.id, scheduler);
    return jsonAnswer(withoutStages(scheduler), 201);
  }

  const scheduler = schedulers.get(schedulerID);
  if (scheduler === undefined || scheduler.user_uuid !== user) return notFound();
  if (route === 'GET /schedulers/:id') return jsonAnswer(withoutStages(scheduler), 200);
  if (route === 'DELETE /schedulers/:id') {
    schedulers.delete(schedulerID);
    return jsonAnswer({ deleted: true }, 200);
  }
  if (route === 'GET /schedulers/:id/stages') {
    return jsonAnswer({ data: [...scheduler.stages].sort((left, right) => left.stage_order - right.stage_order) }, 200);
  }
  if (route === 'POST /schedulers/:id/stages') {
    if (body === null || !Number.isInteger(body.stage_order) || body.stage_order < 0) {
      return jsonAnswer({ error: 'invalid_request', error_description: "Field 'stage_order' is required and must be a non-negative integer" }, 400);
    }
    if (scheduler.stages.some((stage) => stage.stage_order === body.stage_order)) {
      return jsonAnswer({ error: 'conflict', error_description: 'A stage with this order already exists' }, 409);
    }
    const stage = { stage_type: 'crawler', ...body, id: crypto.randomUUID(), scheduler_id: schedulerID };
    scheduler.stages.push(stage);
    return jsonAnswer(stage, 201);
  }
  return jsonAnswer({ error: 'not_found', error_description: 'Endpoint not found' }, 404);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    return url.pathname.startsWith('/__test__/') ? serveTestRoute(request, url) : serveApi(request, url);
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
