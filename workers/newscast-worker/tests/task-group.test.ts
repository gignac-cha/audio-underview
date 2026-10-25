import { describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { DEFAULT_TTS_MODEL } from '@audio-underview/newscast-core';
import worker from '../sources/index.ts';
import type { Environment, NewscastWorkflowParameters } from '../sources/environment.ts';
import { createNewscastSupabaseClient, type NewscastRow } from '../sources/storage.ts';
import {
  NewscastTaskGroup,
  newscastInstanceID,
  reportStageRun,
  summarizeStageRun,
  type TaskGroupStartRequest,
} from '../sources/task-group.ts';
import { TaskGroupInputError } from '../sources/task-group-input.ts';
import { useNewscastsInMemorySupabase, type Row } from './newscasts-in-memory-supabase.ts';

const supabase = useNewscastsInMemorySupabase();
const environment = env as unknown as Environment;

const USER_UUID = '66666666-6666-4666-8666-666666666666';

/**
 * The constructor of WorkerEntrypoint only accepts an ExecutionContext workerd created itself, so
 * the test takes it from a request to SELF, which the main worker receives in fetch().
 */
async function receiveExecutionContext(): Promise<ExecutionContext> {
  const received: { executionContext?: ExecutionContext } = {};
  const spy = vi.spyOn(worker, 'fetch').mockImplementation((async (_request: Request, _environment: unknown, executionContext: ExecutionContext) => {
    received.executionContext = executionContext;
    return new Response(null, { status: 204 });
  }) as unknown as typeof worker.fetch);
  try {
    await SELF.fetch('https://worker.example.com/');
  } finally {
    spy.mockRestore();
  }
  if (received.executionContext === undefined) throw new Error('The main worker did not receive an execution context');
  return received.executionContext;
}

interface BatchInstance {
  id: string;
  params: NewscastWorkflowParameters;
}

/** A Workflow binding that remembers the ids it created, and answers 10405 for one it already has */
function createFakeWorkflow(failing: Set<string> = new Set()) {
  const existing = new Set<string>();
  const batches: BatchInstance[][] = [];
  const binding = {
    createBatch: vi.fn(async ({ instances }: { instances: BatchInstance[] }) => {
      batches.push(instances);
      const created: Array<{ id: string }> = [];
      const errors: Array<{ index: number; id: string; code: number; message: string }> = [];
      instances.forEach((instance, index) => {
        if (failing.has(instance.id)) {
          errors.push({ index, id: instance.id, code: 10001, message: 'instance limit reached' });
        } else if (existing.has(instance.id)) {
          errors.push({ index, id: instance.id, code: 10405, message: 'An instance with this ID already exists.' });
        } else {
          existing.add(instance.id);
          created.push({ id: instance.id });
        }
      });
      return { created, errors };
    }),
  };
  return { binding, batches };
}

async function createTaskGroup(workflow: { createBatch: unknown }): Promise<NewscastTaskGroup> {
  return new NewscastTaskGroup(await receiveExecutionContext(), { ...environment, NEWSCAST_WORKFLOW: workflow } as unknown as Environment);
}

async function schedulerCalls(stageRunID: string): Promise<Array<Record<string, unknown>>> {
  const response = await (environment.SCHEDULER_TASK_GROUP_REPORTS as unknown as Fetcher)
    .fetch(`https://stand-in.example.com/__test__/calls?stageRunID=${stageRunID}`);
  return response.json();
}

async function configureScheduler(stageRunID: string, answers: Record<string, unknown>): Promise<void> {
  await (environment.SCHEDULER_TASK_GROUP_REPORTS as unknown as Fetcher).fetch('https://stand-in.example.com/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ stageRunID, answers }),
  });
}

function article(index: number) {
  return {
    title: `Article ${index}`,
    discussionUrl: `https://news.hada.io/topic?id=${index}`,
    originalUrl: `https://example.com/article-${index}`,
  };
}

function startRequest(stageRunID: string, values: Partial<TaskGroupStartRequest> = {}): TaskGroupStartRequest {
  return {
    stageRunID,
    taskGroupID: 'newscast',
    taskGroupVersion: 1,
    input: Array.from({ length: 5 }, (_value, index) => article(index)),
    settings: {},
    userUUID: USER_UUID,
    ...values,
  };
}

function newscastRows(): Row[] {
  return supabase.tables.newscasts ?? [];
}

function rowOf(values: Partial<NewscastRow>): NewscastRow {
  return {
    id: crypto.randomUUID(),
    user_uuid: USER_UUID,
    stage_run_id: null,
    source_index: 0,
    status: 'running',
    stage: 'tts',
    stage_progress: 0,
    overall_progress: 0,
    title: null,
    title_override: null,
    request: {},
    details: {},
    result: null,
    error: null,
    error_code: null,
    created_at: '2026-10-26T01:00:00.000Z',
    updated_at: '2026-10-26T01:00:00.000Z',
    ...values,
  };
}

describe('summarizeStageRun', () => {
  it('reports how many newscasts are finished while any is running', () => {
    expect(summarizeStageRun([rowOf({ status: 'done' }), rowOf({ status: 'running' }), rowOf({ status: 'error' })])).toEqual({
      kind: 'progress',
      progress: { message: '2 of 3 newscasts finished', completed: 2, total: 3 },
    });
  });

  it('completes with every newscast in source order when all are finished and one is done', () => {
    const done = rowOf({ status: 'done', title: '제목', title_override: '고친 제목' });
    const failed = rowOf({ status: 'error', source_index: 1, title: null, error: 'boom' });

    expect(summarizeStageRun([done, failed])).toEqual({
      kind: 'complete',
      output: {
        newscasts: [
          { id: done.id, status: 'done', title: '고친 제목' },
          { id: failed.id, status: 'error', title: null },
        ],
      },
    });
  });

  it('fails with the first error when every newscast failed', () => {
    expect(summarizeStageRun([
      rowOf({ status: 'error', error: null }),
      rowOf({ status: 'error', source_index: 1, error: 'google: no key is registered for this provider.' }),
      rowOf({ status: 'error', source_index: 2, error: 'later error' }),
    ])).toEqual({
      kind: 'fail',
      errorMessage: 'All 3 newscasts failed: google: no key is registered for this provider.',
    });
  });
});

describe('reportStageRun', () => {
  const client = createNewscastSupabaseClient(environment);

  function seedStageRun(stageRunID: string, statuses: string[]): void {
    supabase.tables.newscasts = statuses.map((status, index) => ({
      ...rowOf({ status: status as NewscastRow['status'], source_index: index, stage_run_id: stageRunID, title: `Article ${index}` }),
      error: status === 'error' ? `error ${index}` : null,
    }));
  }

  it('sends progress, complete or fail as the rows of the stage run call for', async () => {
    const running = crypto.randomUUID();
    seedStageRun(running, ['done', 'running']);
    await reportStageRun(environment, client, running);
    expect(await schedulerCalls(running)).toEqual([
      { method: 'reportProgress', stageRunID: running, progress: { message: '1 of 2 newscasts finished', completed: 1, total: 2 } },
    ]);

    const completed = crypto.randomUUID();
    seedStageRun(completed, ['done', 'error']);
    await reportStageRun(environment, client, completed);
    const [completeCall] = await schedulerCalls(completed);
    expect(completeCall).toMatchObject({ method: 'complete', output: { newscasts: [{ status: 'done', title: 'Article 0' }, { status: 'error', title: 'Article 1' }] } });

    const failed = crypto.randomUUID();
    seedStageRun(failed, ['error', 'error']);
    await reportStageRun(environment, client, failed);
    expect(await schedulerCalls(failed)).toEqual([{ method: 'fail', stageRunID: failed, errorMessage: 'All 2 newscasts failed: error 0' }]);
  });

  it('logs a report the scheduler refuses with a TypeError, and throws any other failure so the step retries', async () => {
    const refused = crypto.randomUUID();
    seedStageRun(refused, ['done']);
    await configureScheduler(refused, { complete: { error: 'output must be an object', typeError: true } });
    await expect(reportStageRun(environment, client, refused)).resolves.toMatchObject({ kind: 'complete' });

    const unreachable = crypto.randomUUID();
    seedStageRun(unreachable, ['done']);
    await configureScheduler(unreachable, { complete: { error: 'instance unreachable' } });
    await expect(() => reportStageRun(environment, client, unreachable)).rejects.toThrow('instance unreachable');
  });

  it('accepts that the scheduler did not take a report', async () => {
    const ended = crypto.randomUUID();
    seedStageRun(ended, ['running']);
    await configureScheduler(ended, { reportProgress: { accepted: false } });

    await expect(reportStageRun(environment, client, ended)).resolves.toMatchObject({ kind: 'progress' });
  });
});

describe('NewscastTaskGroup.startTaskGroupRun', () => {
  it('inserts one row and creates one instance per source, then reports the first progress', async () => {
    const stageRunID = crypto.randomUUID();
    const workflow = createFakeWorkflow();
    const group = await createTaskGroup(workflow.binding);

    await group.startTaskGroupRun(startRequest(stageRunID));

    const rows = newscastRows();
    expect(rows.map((row) => [row.source_index, row.title, row.status, row.stage])).toEqual([
      [0, 'Article 0', 'running', 'crawl-list'],
      [1, 'Article 1', 'running', 'crawl-list'],
      [2, 'Article 2', 'running', 'crawl-list'],
    ]);
    expect(rows[0]).toMatchObject({ user_uuid: USER_UUID, stage_run_id: stageRunID });
    expect(rows[0].request).toMatchObject({
      limit: 1,
      entries: [article(0)],
      provider: 'google',
      lengthPreference: 'standard',
      ttsModel: DEFAULT_TTS_MODEL,
      signal: false,
    });
    expect(rows[0].request).toHaveProperty('speaker1Voice');

    expect(workflow.batches).toHaveLength(1);
    expect(workflow.batches[0]).toEqual(rows.map((row) => ({
      id: `${stageRunID}-${row.source_index}`,
      params: { newscastID: row.id, userUUID: USER_UUID, stageRunID, request: row.request },
    })));
    expect(await schedulerCalls(stageRunID)).toEqual([
      { method: 'reportProgress', stageRunID, progress: { message: '0 of 3 newscasts finished', completed: 0, total: 3 } },
    ]);
  });

  it('makes no second row or instance when the same stage run starts again', async () => {
    const stageRunID = crypto.randomUUID();
    const workflow = createFakeWorkflow();
    const group = await createTaskGroup(workflow.binding);
    await group.startTaskGroupRun(startRequest(stageRunID));
    const firstRows = structuredClone(newscastRows());

    await group.startTaskGroupRun(startRequest(stageRunID));

    // The same rows, voices included, and the same instances asked for again, all of which exist
    expect(newscastRows()).toEqual(firstRows);
    expect(workflow.batches[1]).toEqual(workflow.batches[0]);
    const results = await Promise.all(workflow.binding.createBatch.mock.results.map((result) => result.value));
    expect(results[1]).toMatchObject({ created: [] });
    expect(results[1].errors.map((error: { code: number }) => error.code)).toEqual([10405, 10405, 10405]);
  });

  it('creates the instances a first start did not get to, from the rows it stored', async () => {
    const stageRunID = crypto.randomUUID();
    const failingID = newscastInstanceID(stageRunID, 1);
    const failing = new Set([failingID]);
    const workflow = createFakeWorkflow(failing);
    const group = await createTaskGroup(workflow.binding);

    await expect(() => group.startTaskGroupRun(startRequest(stageRunID))).rejects.toThrow(
      'Could not start 1 of 3 newscasts: instance limit reached',
    );
    failing.delete(failingID);
    await group.startTaskGroupRun(startRequest(stageRunID));

    const results = await Promise.all(workflow.binding.createBatch.mock.results.map((result) => result.value));
    expect(results[1].created).toEqual([{ id: failingID }]);
    expect(newscastRows()).toHaveLength(3);
  });

  it('records a pasted text with its source flag and part count, read verbatim when the setting says so', async () => {
    const stageRunID = crypto.randomUUID();
    const workflow = createFakeWorkflow();
    const group = await createTaskGroup(workflow.binding);

    await group.startTaskGroupRun(startRequest(stageRunID, {
      input: { text: '화자1: 첫 문장입니다.\n화자2: 둘째 문장입니다.' },
      settings: { verbatim: true, signal: true },
    }));

    const [row] = newscastRows();
    expect(row).toMatchObject({
      title: '첫 문장입니다.',
      details: { customArticle: { verbatim: true, partCount: 1 } },
      request: { customArticle: { content: '화자1: 첫 문장입니다.\n화자2: 둘째 문장입니다.', verbatim: true }, signal: true },
    });
  });

  it('fails the stage with what is wrong, before it writes anything', async () => {
    const workflow = createFakeWorkflow();
    const group = await createTaskGroup(workflow.binding);

    await expect(() => group.startTaskGroupRun(startRequest(crypto.randomUUID(), { input: {} }))).rejects.toThrow(
      'The input has no source',
    );
    await expect(() => group.startTaskGroupRun(startRequest(crypto.randomUUID(), { userUUID: 'AAAAAAAA-6666-4666-8666-666666666666' })))
      .rejects.toThrow('userUUID must be a lowercase UUID.');
    await expect(() => group.startTaskGroupRun(startRequest(crypto.randomUUID(), { settings: { article_limit: 20 } })))
      .rejects.toBeInstanceOf(TaskGroupInputError);
    expect(newscastRows()).toHaveLength(0);
    expect(workflow.binding.createBatch).not.toHaveBeenCalled();
  });

  it('starts even when the first progress report cannot be sent', async () => {
    const stageRunID = crypto.randomUUID();
    await configureScheduler(stageRunID, { reportProgress: { error: 'scheduler is down' } });
    const workflow = createFakeWorkflow();
    const group = await createTaskGroup(workflow.binding);

    await expect(group.startTaskGroupRun(startRequest(stageRunID, { input: { url: 'https://example.com/post' } }))).resolves.toBeUndefined();

    expect(newscastRows()).toHaveLength(1);
    expect(newscastRows()[0]).toMatchObject({ title: 'https://example.com/post', request: { url: 'https://example.com/post' } });
    expect(workflow.binding.createBatch).toHaveBeenCalledTimes(1);
  });
});
