import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { WorkflowStepConfig } from 'cloudflare:workers';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import { signJWT } from '@audio-underview/worker-tools';
import worker, { type Environment } from '../sources/index.ts';
import type { CrawlerExecutionClient } from '../sources/crawler-execution-client.ts';
import { runScheduledPipeline } from '../sources/scheduled-pipeline.ts';
import type { ScheduledPipelineDependencies, ScheduledPipelineStep } from '../sources/scheduled-pipeline.ts';
import { type Row, useInMemorySupabase } from './in-memory-supabase.ts';

// A form stage in a Workflow run: the form is shown, the run waits, and the answer the owner sends
// through the answer route (or the cancel) decides how the stage ends.

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const WORKER_URL = 'https://worker.example.com';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const LIST_STAGE_ID = '00000000-0000-0000-0000-000000000020';
const FORM_STAGE_ID = '00000000-0000-0000-0000-000000000021';
const NEXT_STAGE_ID = '00000000-0000-0000-0000-000000000022';
const LIST_CRAWLER_ID = '00000000-0000-0000-0000-000000000030';
const NEXT_CRAWLER_ID = '00000000-0000-0000-0000-000000000031';
const RUN_ID = '00000000-0000-0000-0000-000000000040';
const EXISTING_STAGE_RUN_ID = '00000000-0000-0000-0000-000000000050';

const RECORD_STEP_OPTIONS = {
  retries: { limit: 5, delay: '3 seconds', backoff: 'exponential' },
  timeout: '1 minute',
};
const EXECUTE_STEP_OPTIONS = {
  retries: { limit: 0, delay: 0 },
  timeout: '15 minutes',
};

const ARTICLES = [
  { title: 'First', discussionUrl: 'https://news.hada.io/topic?id=1', originalUrl: 'https://a.example.com/1' },
  { title: 'Second', discussionUrl: 'https://news.hada.io/topic?id=2', originalUrl: 'https://a.example.com/2' },
  { title: 'Third', discussionUrl: 'https://news.hada.io/topic?id=3', originalUrl: 'https://a.example.com/3' },
];

const ARTICLES_SETTINGS = {
  form: {
    type: 'object',
    properties: {
      articles: {
        type: 'array',
        'x-widget': 'checkboxes',
        'x-options': { from: '$', label: 'title', description: 'originalUrl' },
        minItems: 1,
        maxItems: 10,
      },
    },
    required: ['articles'],
  },
  timeout_minutes: 30,
};

const supabase = useInMemorySupabase(SUPABASE_ORIGIN);

function stageRow(overrides: Row = {}): Row {
  return {
    id: LIST_STAGE_ID,
    scheduler_id: SCHEDULER_ID,
    stage_type: 'crawler',
    crawler_id: LIST_CRAWLER_ID,
    task_group_id: null,
    task_group_version: null,
    settings: null,
    stage_order: 0,
    input_schema: { url: { type: 'string', default: 'https://news.hada.io/' } },
    output_schema: {},
    fan_out_field: null,
    fan_out_strategy: 'compact',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function formStageRow(overrides: Row = {}): Row {
  return stageRow({
    id: FORM_STAGE_ID,
    stage_type: 'form',
    crawler_id: null,
    settings: ARTICLES_SETTINGS,
    stage_order: 1,
    input_schema: {},
    ...overrides,
  });
}

const nextStageRow = () => stageRow({ id: NEXT_STAGE_ID, crawler_id: NEXT_CRAWLER_ID, stage_order: 2, input_schema: {} });

function seed(stages: Row[], runOverrides: Row = {}) {
  supabase.tables.schedulers = [{
    id: SCHEDULER_ID,
    user_uuid: USER_UUID,
    name: 'Newscast from GeekNews',
    cron_expression: null,
    timezone: 'Asia/Seoul',
    is_enabled: false,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }];
  supabase.tables.scheduler_runs = [{
    id: RUN_ID,
    scheduler_id: SCHEDULER_ID,
    status: 'pending',
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-26T00:00:00.000Z',
    ...runOverrides,
  }];
  supabase.tables.scheduler_stages = stages;
  supabase.tables.scheduler_stage_runs = [];
}

function run(): Row {
  return supabase.tables.scheduler_runs[0];
}

function findStageRun(stageID: string): Row | undefined {
  return supabase.tables.scheduler_stage_runs.find((stageRun) => stageRun.stage_id === stageID);
}

// --- Fake Workflow step: calls the callback at once and records every call ---

interface WaitForEventOptions {
  type: string;
  timeout: string;
}

interface RecordedStep {
  name: string;
  options: WorkflowStepConfig | WaitForEventOptions;
  result?: unknown;
}

interface FakeStepOptions {
  /** Steps that fail on their own, for example by timing out, without running their callback */
  throwingSteps?: Record<string, Error>;
  /** Runs before a step's callback */
  beforeStep?: (name: string) => void;
  /** Stands for the wait: may answer through the route, or throw like a timeout. Resolves at once when absent. */
  onWaitForEvent?: (name: string, options: WaitForEventOptions) => Promise<void> | void;
}

function createFakeStep(options: FakeStepOptions = {}): ScheduledPipelineStep & { steps: RecordedStep[] } {
  const steps: RecordedStep[] = [];
  return {
    steps,
    async do<T>(name: string, stepOptions: WorkflowStepConfig, callback: () => Promise<T>): Promise<T> {
      const recorded: RecordedStep = { name, options: stepOptions };
      steps.push(recorded);
      const error = options.throwingSteps?.[name];
      if (error !== undefined) throw error;
      options.beforeStep?.(name);
      const result = await callback();
      recorded.result = result;
      return result;
    },
    async waitForEvent(name: string, waitOptions: WaitForEventOptions): Promise<unknown> {
      steps.push({ name, options: waitOptions });
      await options.onWaitForEvent?.(name, waitOptions);
      return { type: waitOptions.type, payload: {}, timestamp: new Date() };
    },
  };
}

function stepNames(step: { steps: RecordedStep[] }): string[] {
  return step.steps.map((recorded) => recorded.name);
}

function stepResult(step: { steps: RecordedStep[] }, name: string): unknown {
  return step.steps.find((recorded) => recorded.name === name)?.result;
}

// --- Dependencies ---

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    createChild: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createDependencies(...results: unknown[]): {
  dependencies: ScheduledPipelineDependencies;
  crawl: ReturnType<typeof vi.fn>;
} {
  const crawl = vi.fn(async () => ({ status: 'completed' as const, type: 'data' as const, result: { published: true }, logs: [], logs_truncated: false }));
  for (const result of results) {
    crawl.mockImplementationOnce(async () => ({ status: 'completed' as const, type: 'data' as const, result, logs: [], logs_truncated: false }));
  }
  const crawlerExecutionClient: CrawlerExecutionClient = { run: crawl };
  return {
    dependencies: {
      supabaseClient: createSupabaseClient({
        supabaseURL: env.SUPABASE_URL,
        supabaseSecretKey: env.SUPABASE_SECRET_KEY,
        schema: env.SUPABASE_SCHEMA,
      }),
      crawlerExecutionClient,
      logger: createMockLogger(),
      resolveTaskGroupWorker: () => undefined,
    },
    crawl,
  };
}

// The Workflow binding the answer route wakes instances through
function createWorkflow() {
  const events: { instanceID: string; type: string; payload: unknown }[] = [];
  const get = vi.fn(async (instanceID: string) => ({
    id: instanceID,
    sendEvent: async (event: { type: string; payload: unknown }) => {
      events.push({ instanceID, ...event });
    },
  }));
  return { get, events };
}

// What the owner sends from the web page while the run waits
async function sendStageRunAction(
  workflow: ReturnType<typeof createWorkflow>,
  stageRunID: string,
  action: 'answer' | 'cancel',
  body?: unknown,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub: USER_UUID, iat: now, exp: now + 86400 }, JWT_SECRET);
  const request = new Request(`${WORKER_URL}/schedulers/${SCHEDULER_ID}/runs/${RUN_ID}/stage-runs/${stageRunID}/${action}`, {
    method: 'POST',
    headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, { ...env, SCHEDULER_RUN_WORKFLOW: workflow } as unknown as Environment);
}

function stageRunIDOfEvent(options: WaitForEventOptions): string {
  return options.type.slice('form-answered-'.length);
}

function answerWhileWaiting(workflow: ReturnType<typeof createWorkflow>, answer: unknown): FakeStepOptions['onWaitForEvent'] {
  return async (_, options) => {
    const response = await sendStageRunAction(workflow, stageRunIDOfEvent(options), 'answer', { answer });
    expect(response.status).toBe(200);
  };
}

const parameters = { schedulerID: SCHEDULER_ID, runID: RUN_ID };

describe('runScheduledPipeline with a form stage', () => {
  it('shows the form of the list before it, waits for the answer, and passes the chosen items to the next stage', async () => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies, crawl } = createDependencies(ARTICLES);
    const workflow = createWorkflow();
    const whileWaiting: { run?: Row; stageRun?: Row } = {};
    const answer = answerWhileWaiting(workflow, { articles: [2, 0] })!;
    const step = createFakeStep({
      onWaitForEvent: async (name, options) => {
        whileWaiting.run = { ...run() };
        whileWaiting.stageRun = { ...findStageRun(FORM_STAGE_ID)! };
        await answer(name, options);
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const formStageRun = findStageRun(FORM_STAGE_ID)!;
    expect(step.steps.map(({ name, options }) => ({ name, options }))).toEqual([
      { name: 'begin-run', options: RECORD_STEP_OPTIONS },
      { name: 'load-stages', options: RECORD_STEP_OPTIONS },
      { name: 'stage-0', options: EXECUTE_STEP_OPTIONS },
      { name: 'stage-1', options: RECORD_STEP_OPTIONS },
      { name: 'stage-1-answered', options: { type: `form-answered-${formStageRun.id}`, timeout: '30 minutes' } },
      { name: 'stage-1-result', options: RECORD_STEP_OPTIONS },
      { name: 'stage-2', options: EXECUTE_STEP_OPTIONS },
      { name: 'finish-run', options: RECORD_STEP_OPTIONS },
    ]);

    // While it waited, the run was running and only the form stage run was waiting
    expect(whileWaiting.run).toMatchObject({ status: 'running' });
    expect(whileWaiting.stageRun).toMatchObject({ status: 'waiting', completed_at: null, output: null });
    expect(supabase.requestsOf('POST', 'scheduler_stage_runs').map((request) => request.body?.status)).toEqual(['running', 'waiting', 'running']);

    // The stage run kept its input and the form it showed
    expect(formStageRun).toMatchObject({ stage_order: 1, status: 'completed', input: ARTICLES, task_group_id: null });
    const form = formStageRun.form as { schema: Row; fields: Row[]; expires_at: string };
    expect(form.schema).toEqual({
      type: 'object',
      properties: { articles: { type: 'array', items: { type: 'integer', enum: [0, 1, 2] }, minItems: 1, maxItems: 10 } },
      required: ['articles'],
      additionalProperties: false,
    });
    expect(form.fields).toEqual([{
      name: 'articles',
      widget: 'checkboxes',
      required: true,
      choices: ARTICLES.map((article) => ({ label: article.title, description: article.originalUrl })),
      minItems: 1,
      maxItems: 10,
    }]);
    expect(Date.parse(form.expires_at) - Date.parse(formStageRun.started_at as string)).toBe(30 * 60_000);

    // The answer is the items the numbers stand for, and the next stage gets it
    expect(formStageRun.output).toEqual({ articles: [ARTICLES[2], ARTICLES[0]] });
    expect(crawl).toHaveBeenNthCalledWith(2, NEXT_CRAWLER_ID, { articles: [ARTICLES[2], ARTICLES[0]] }, { userUUID: USER_UUID, runID: RUN_ID });
    expect(workflow.events).toEqual([{
      instanceID: `manual-${RUN_ID}`,
      type: `form-answered-${formStageRun.id}`,
      payload: { stageRunID: formStageRun.id },
    }]);

    expect(result).toEqual({ outcome: 'started', runID: RUN_ID, status: 'completed' });
    expect(run()).toMatchObject({ status: 'completed', result: { published: true }, error: null });

    // No step result carries the list or the answer
    for (const recorded of step.steps) {
      expect(JSON.stringify(recorded.result ?? null)).not.toContain('a.example.com');
    }
  });

  it('gives the form {} when it is the first stage, and waits 24 hours without timeout_minutes', async () => {
    const urlSettings = {
      form: { type: 'object', properties: { url: { type: 'string', 'x-widget': 'text', format: 'uri', maxLength: 2048 } }, required: ['url'] },
    };
    seed([formStageRow({ stage_order: 0, settings: urlSettings }), stageRow({ id: NEXT_STAGE_ID, crawler_id: NEXT_CRAWLER_ID, stage_order: 1, input_schema: {} })]);
    const { dependencies, crawl } = createDependencies();
    const workflow = createWorkflow();
    const step = createFakeStep({ onWaitForEvent: answerWhileWaiting(workflow, { url: 'https://a.example.com/article' }) });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const formStageRun = findStageRun(FORM_STAGE_ID)!;
    expect(formStageRun).toMatchObject({ input: {}, status: 'completed', output: { url: 'https://a.example.com/article' } });
    expect(step.steps.find((recorded) => recorded.name === 'stage-0-answered')?.options).toEqual({
      type: `form-answered-${formStageRun.id}`,
      timeout: '1440 minutes',
    });
    const form = formStageRun.form as { expires_at: string };
    expect(Date.parse(form.expires_at) - Date.parse(formStageRun.started_at as string)).toBe(1440 * 60_000);
    expect(crawl).toHaveBeenCalledWith(NEXT_CRAWLER_ID, { url: 'https://a.example.com/article' }, { userUUID: USER_UUID, runID: RUN_ID });
    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
  });

  it('stores the answer as the run result when the form is the last stage', async () => {
    seed([stageRow(), formStageRow()]);
    const { dependencies } = createDependencies(ARTICLES);
    const workflow = createWorkflow();
    const step = createFakeStep({ onWaitForEvent: answerWhileWaiting(workflow, { articles: [1] }) });

    await runScheduledPipeline(dependencies, parameters, step);

    expect(run()).toMatchObject({ status: 'completed', result: { articles: [ARTICLES[1]] } });
  });

  it('fails the stage run and the run when no answer comes within the timeout', async () => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies, crawl } = createDependencies(ARTICLES);
    const step = createFakeStep({
      onWaitForEvent: () => {
        throw new Error('Workflow waitForEvent timed out');
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 1: no answer within 30 minutes';
    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-1', 'stage-1-answered', 'stage-1-result', 'finish-run']);
    expect(stepResult(step, 'stage-1-result')).toEqual({ status: 'failed', error });
    expect(findStageRun(FORM_STAGE_ID)).toMatchObject({ status: 'failed', error, completed_at: expect.any(String), output: null });
    // Failed only while still waiting
    const settleUpdates = supabase.requestsOf('PATCH', 'scheduler_stage_runs').filter((request) => request.query.get('status') === 'in.(waiting)');
    expect(settleUpdates).toHaveLength(1);
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: 'started', runID: RUN_ID, status: 'failed' });
    expect(run()).toMatchObject({ status: 'failed', error });
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      'Form stage was not answered',
      expect.objectContaining({ error: 'Workflow waitForEvent timed out' }),
      { function: 'runScheduledPipeline' },
    );
  });

  it('fails the run when the owner cancels the form', async () => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies, crawl } = createDependencies(ARTICLES);
    const workflow = createWorkflow();
    const step = createFakeStep({
      onWaitForEvent: async (_, options) => {
        const response = await sendStageRunAction(workflow, stageRunIDOfEvent(options), 'cancel');
        expect(response.status).toBe(200);
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 1: cancelled by the owner';
    const formStageRun = findStageRun(FORM_STAGE_ID)!;
    expect(stepResult(step, 'stage-1-result')).toEqual({ status: 'failed', error });
    expect(formStageRun).toMatchObject({ status: 'failed', error, output: null });
    expect(workflow.events).toEqual([{ instanceID: `manual-${RUN_ID}`, type: `form-answered-${formStageRun.id}`, payload: { stageRunID: formStageRun.id } }]);
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(run()).toMatchObject({ status: 'failed', error });
  });

  it.each([
    ['an empty list', []],
    ['an object instead of a list', { articles: ARTICLES }],
  ])('records a failed stage run without waiting when the stage before it gives %s', async (_, output) => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies, crawl } = createDependencies(output);
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({ onWaitForEvent });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = "Stage 1: no choices for 'articles'";
    expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-1', 'finish-run']);
    expect(stepResult(step, 'stage-1')).toEqual({ status: 'failed', error });
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(findStageRun(FORM_STAGE_ID)).toMatchObject({
      status: 'failed',
      error,
      input: output,
      form: null,
      started_at: expect.any(String),
      completed_at: expect.any(String),
    });
    // Created as failed from the start, never as waiting
    expect(supabase.requestsOf('POST', 'scheduler_stage_runs').map((request) => request.body?.status)).toEqual(['running', 'failed']);
    expect(crawl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(run()).toMatchObject({ status: 'failed', error });
  });

  it('records a failed stage run when the saved definition is not a valid form', async () => {
    seed([formStageRow({ stage_order: 0, settings: { form: { type: 'object', properties: {} } } })]);
    const { dependencies } = createDependencies();
    const step = createFakeStep();

    await runScheduledPipeline(dependencies, parameters, step);

    const error = "Stage 0: form definition is not valid: Field 'settings.form' is not a valid form: $.properties must have at least one field";
    expect(stepResult(step, 'stage-0')).toEqual({ status: 'failed', error });
    expect(findStageRun(FORM_STAGE_ID)).toMatchObject({ status: 'failed', error });
    expect(run()).toMatchObject({ status: 'failed', error });
  });

  it('fails the stage without a stage run when the output of the stage before it cannot be read', async () => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies } = createDependencies(ARTICLES);
    const onWaitForEvent = vi.fn();
    const step = createFakeStep({
      onWaitForEvent,
      // The first stage run disappears before the form stage reads it
      beforeStep: (name) => {
        if (name === 'stage-1') supabase.tables.scheduler_stage_runs = [];
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    const error = 'Stage 1: previous stage output not found';
    expect(stepResult(step, 'stage-1')).toEqual({ status: 'failed', error });
    expect(supabase.tables.scheduler_stage_runs).toEqual([]);
    expect(onWaitForEvent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(run()).toMatchObject({ status: 'failed', error });
  });

  it('goes on to the next stage when the wait throws but the answer already arrived', async () => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies, crawl } = createDependencies(ARTICLES);
    const workflow = createWorkflow();
    const answer = answerWhileWaiting(workflow, { articles: [1] })!;
    const step = createFakeStep({
      onWaitForEvent: async (name, options) => {
        await answer(name, options);
        throw new Error('Workflow waitForEvent timed out');
      },
    });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(stepResult(step, 'stage-1-result')).toEqual({ status: 'completed', stageRunID: findStageRun(FORM_STAGE_ID)!.id });
    expect(crawl).toHaveBeenNthCalledWith(2, NEXT_CRAWLER_ID, { articles: [ARTICLES[1]] }, { userUUID: USER_UUID, runID: RUN_ID });
    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
  });

  it('reads the stage run again when the answer arrived after the result step read it as waiting', async () => {
    seed([stageRow(), formStageRow(), nextStageRow()]);
    const { dependencies, crawl } = createDependencies(ARTICLES);
    // The answer lands after the result step read the stage run, and before its update is applied
    supabase.intercept = (request) => {
      if (request.method === 'PATCH' && request.table === 'scheduler_stage_runs' && request.query.get('status') === 'in.(waiting)') {
        supabase.intercept = undefined;
        Object.assign(findStageRun(FORM_STAGE_ID)!, { status: 'completed', output: { articles: ['answered in between'] }, completed_at: '2026-10-26T00:10:00.000Z' });
      }
      return undefined;
    };
    const step = createFakeStep();

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(stepResult(step, 'stage-1-result')).toEqual({ status: 'completed', stageRunID: findStageRun(FORM_STAGE_ID)!.id });
    expect(findStageRun(FORM_STAGE_ID)).toMatchObject({ status: 'completed', error: null, output: { articles: ['answered in between'] } });
    expect(crawl).toHaveBeenNthCalledWith(2, NEXT_CRAWLER_ID, { articles: ['answered in between'] }, { userUUID: USER_UUID, runID: RUN_ID });
    expect(result).toMatchObject({ outcome: 'started', status: 'completed' });
  });

  it('closes the waiting stage run in finish-run when a step itself throws', async () => {
    seed([stageRow(), formStageRow()]);
    const { dependencies } = createDependencies(ARTICLES);
    const step = createFakeStep({ throwingSteps: { 'stage-1-result': new Error('Step stage-1-result timed out') } });

    const result = await runScheduledPipeline(dependencies, parameters, step);

    expect(result).toMatchObject({ outcome: 'started', status: 'failed' });
    expect(run()).toMatchObject({ status: 'failed', error: 'Step stage-1-result timed out' });
    expect(findStageRun(FORM_STAGE_ID)).toMatchObject({
      status: 'failed',
      error: 'Run ended before this stage finished',
      completed_at: expect.any(String),
    });
  });

  describe('when the start step runs again', () => {
    function existingStageRun(overrides: Row = {}): Row {
      return {
        id: EXISTING_STAGE_RUN_ID,
        run_id: RUN_ID,
        stage_id: FORM_STAGE_ID,
        stage_order: 0,
        status: 'waiting',
        started_at: '2026-10-26T00:00:00.000Z',
        completed_at: null,
        input: { from: 'first attempt' },
        output: null,
        error: null,
        items_total: null,
        items_succeeded: null,
        items_failed: null,
        task_group_id: null,
        task_group_version: null,
        progress: null,
        form: {
          schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
          fields: [{ name: 'text', widget: 'textarea', required: false }],
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        created_at: '2026-10-26T00:00:00.000Z',
        ...overrides,
      };
    }

    const textSettings = { form: { type: 'object', properties: { text: { type: 'string', 'x-widget': 'textarea' } } }, timeout_minutes: 30 };

    it('waits the rest of the time for the waiting stage run a previous attempt left, without a new one', async () => {
      seed([formStageRow({ stage_order: 0, settings: textSettings })], { status: 'running' });
      supabase.tables.scheduler_stage_runs = [existingStageRun()];
      const { dependencies } = createDependencies();
      const workflow = createWorkflow();
      const step = createFakeStep({ onWaitForEvent: answerWhileWaiting(workflow, { text: 'hello' }) });

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepResult(step, 'stage-0')).toEqual({ status: 'waiting', stageRunID: EXISTING_STAGE_RUN_ID, waitMinutes: 10 });
      expect(step.steps.find((recorded) => recorded.name === 'stage-0-answered')?.options).toEqual({
        type: `form-answered-${EXISTING_STAGE_RUN_ID}`,
        timeout: '10 minutes',
      });
      expect(supabase.requestsOf('POST', 'scheduler_stage_runs')).toHaveLength(0);
      expect(result).toEqual({ outcome: 'started', runID: RUN_ID, status: 'completed' });
      expect(run()).toMatchObject({ status: 'completed', result: { text: 'hello' } });
    });

    it('waits at least a minute for a stage run whose form has expired', async () => {
      seed([formStageRow({ stage_order: 0, settings: textSettings })], { status: 'running' });
      supabase.tables.scheduler_stage_runs = [existingStageRun({
        form: { ...existingStageRun().form as Row, expires_at: '2026-10-25T00:00:00.000Z' },
      })];
      const { dependencies } = createDependencies();
      const step = createFakeStep({
        onWaitForEvent: () => {
          throw new Error('Workflow waitForEvent timed out');
        },
      });

      await runScheduledPipeline(dependencies, parameters, step);

      expect(stepResult(step, 'stage-0')).toEqual({ status: 'waiting', stageRunID: EXISTING_STAGE_RUN_ID, waitMinutes: 1 });
      expect(run()).toMatchObject({ status: 'failed', error: 'Stage 0: no answer within 30 minutes' });
    });

    it('reads the result without waiting when a previous attempt left an ended stage run', async () => {
      seed([formStageRow({ stage_order: 0, settings: textSettings })], { status: 'running' });
      supabase.tables.scheduler_stage_runs = [existingStageRun({ status: 'completed', output: { text: 'earlier' }, completed_at: '2026-10-26T00:05:00.000Z' })];
      const { dependencies } = createDependencies();
      const onWaitForEvent = vi.fn();
      const step = createFakeStep({ onWaitForEvent });

      const result = await runScheduledPipeline(dependencies, parameters, step);

      expect(stepNames(step)).toEqual(['begin-run', 'load-stages', 'stage-0', 'stage-0-result', 'finish-run']);
      expect(stepResult(step, 'stage-0')).toEqual({ status: 'settled', stageRunID: EXISTING_STAGE_RUN_ID });
      expect(onWaitForEvent).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'started', runID: RUN_ID, status: 'completed' });
      expect(run()).toMatchObject({ status: 'completed', result: { text: 'earlier' } });
    });
  });
});
