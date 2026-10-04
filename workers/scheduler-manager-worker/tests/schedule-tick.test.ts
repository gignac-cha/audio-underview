import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import { runScheduleTick } from '../sources/schedule-tick.ts';
import type { ScheduleTickDependencies } from '../sources/schedule-tick.ts';

const SUPABASE_ORIGIN = 'https://supabase.example.com';
const USER_UUID = '00000000-0000-0000-0000-000000000001';
const SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';
const SCHEDULER_ID_2 = '00000000-0000-0000-0000-000000000011';
const SCHEDULER_ID_3 = '00000000-0000-0000-0000-000000000012';

function mockSchedulerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULER_ID,
    user_uuid: USER_UUID,
    name: 'Test Scheduler',
    cron_expression: '0 7 * * *',
    timezone: 'Asia/Seoul',
    is_enabled: true,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000040',
    scheduler_id: SCHEDULER_ID,
    status: 'running',
    started_at: '2026-10-05T20:00:00.000Z',
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
    created_at: '2026-10-05T20:00:00.000Z',
    ...overrides,
  };
}

// 500 schedulers without a next run, a full initialize page, each with its own (created_at, id) key
function schedulerPage(page: number, cronExpression: string) {
  return Array.from({ length: 500 }, (_, index) => mockSchedulerRow({
    id: `00000000-0000-0000-0000-${String(10000 + page * 1000 + index).padStart(12, '0')}`,
    cron_expression: cronExpression,
    created_at: `2026-01-0${page + 1}T00:00:00.${String(index).padStart(6, '0')}+00:00`,
  }));
}

// `count` schedulers due at `nextRunAt`
function dueSchedulers(count: number, nextRunAt: string) {
  return Array.from({ length: count }, (_, index) => mockSchedulerRow({
    id: `00000000-0000-0000-0000-${String(1000 + index).padStart(12, '0')}`,
    next_run_at: nextRunAt,
  }));
}

function instanceIDOf(schedulerID: string, scheduledFor: string): string {
  return `${schedulerID}-${Math.floor(Date.parse(scheduledFor) / 60000)}`;
}

// --- Supabase mock helpers ---

interface SupabaseRequest {
  method: string;
  table: string;
  query: string;
  body: Record<string, unknown> | undefined;
}

// One element of the set_scheduler_next_runs RPC argument
interface NextRunUpdatePayload {
  id: string;
  expected_next_run_at: string | null;
  next_run_at: string | null;
}

let supabaseRequests: SupabaseRequest[] = [];
let events: string[] = [];

function interceptSupabase(
  method: string,
  table: string,
  path: RegExp,
  respond: (request: SupabaseRequest) => { statusCode: number; data: unknown },
  times: number = 1,
) {
  fetchMock
    .get(SUPABASE_ORIGIN)
    .intercept({ path, method })
    .reply((options) => {
      const decodedPath = decodeURIComponent(String(options.path));
      // A GET request arrives with an empty body
      const rawBody = String(options.body ?? '');
      const request: SupabaseRequest = {
        method,
        table,
        query: decodedPath.slice(decodedPath.indexOf('?') + 1),
        body: rawBody === '' ? undefined : JSON.parse(rawBody) as Record<string, unknown>,
      };
      supabaseRequests.push(request);
      const { statusCode, data } = respond(request);
      return { statusCode, data: JSON.stringify(data) };
    })
    .times(times);
}

function mockListActiveRuns(runs: unknown[]) {
  interceptSupabase('GET', 'scheduler_runs', /^\/rest\/v1\/scheduler_runs\?/, () => ({ statusCode: 200, data: runs }));
}

// An RPC is a POST to /rest/v1/rpc/<name>; a SETOF UUID function answers with an array of IDs.
// By default every run sent is reported as changed.
function mockFailSchedulerRuns(changedIDsOf: (runIDs: string[]) => string[] = (runIDs) => runIDs) {
  interceptSupabase('POST', 'rpc/fail_scheduler_runs', /^\/rest\/v1\/rpc\/fail_scheduler_runs/, (request) => {
    const runIDs = request.body?.run_ids as string[];
    events.push(`failSchedulerRuns:${runIDs.length}`);
    return { statusCode: 200, data: changedIDsOf(runIDs) };
  });
}

function mockListSchedulersWithoutNextRun(schedulers: unknown[]) {
  interceptSupabase('GET', 'schedulers', /^\/rest\/v1\/schedulers\?.*next_run_at=is\.null/, () => ({ statusCode: 200, data: schedulers }));
}

function mockListSchedulersDue(schedulers: unknown[]) {
  interceptSupabase('GET', 'schedulers', /^\/rest\/v1\/schedulers\?.*next_run_at=lte\./, () => ({ statusCode: 200, data: schedulers }));
}

// By default every scheduler sent is reported as changed
function mockSetSchedulerNextRuns(
  times: number = 1,
  changedIDsOf: (updates: NextRunUpdatePayload[]) => string[] = (updates) => updates.map((update) => update.id),
) {
  interceptSupabase('POST', 'rpc/set_scheduler_next_runs', /^\/rest\/v1\/rpc\/set_scheduler_next_runs/, (request) => {
    const updates = request.body?.updates as NextRunUpdatePayload[];
    events.push(`setSchedulerNextRuns:${updates.length}`);
    return { statusCode: 200, data: changedIDsOf(updates) };
  }, times);
}

function requestsOf(method: string, table: string): SupabaseRequest[] {
  return supabaseRequests.filter((request) => request.method === method && request.table === table);
}

function setSchedulerNextRunsRequests(): SupabaseRequest[] {
  return requestsOf('POST', 'rpc/set_scheduler_next_runs');
}

function failSchedulerRunsRequests(): SupabaseRequest[] {
  return requestsOf('POST', 'rpc/fail_scheduler_runs');
}

function nextRunUpdatesOf(request: SupabaseRequest): NextRunUpdatePayload[] {
  return request.body?.updates as NextRunUpdatePayload[];
}

// --- Workflow fake ---

type InstanceStatusValue = InstanceStatus['status'];

// An Error in place of a status makes that instance's status() throw it
function createFakeWorkflow(instanceStatuses: Record<string, InstanceStatusValue | Error> = {}) {
  const createBatch = vi.fn(async (batch: WorkflowInstanceCreateOptions[]) => {
    events.push(`createBatch:${batch.length}`);
    return batch.map((options) => ({ id: options.id }));
  });
  const get = vi.fn(async (id: string) => {
    const status = instanceStatuses[id];
    if (status === undefined) {
      throw new Error(`instance.not_found: ${id}`);
    }
    return {
      id,
      status: async () => {
        if (status instanceof Error) throw status;
        return { status };
      },
    };
  });
  return { createBatch, get };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    createChild: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

function createDependencies(workflow: ReturnType<typeof createFakeWorkflow>): ScheduleTickDependencies {
  const supabaseClient = createSupabaseClient({
    supabaseURL: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  });
  return {
    supabaseClient,
    workflow: workflow as unknown as ScheduleTickDependencies['workflow'],
    logger: createMockLogger(),
  };
}

beforeEach(() => {
  supabaseRequests = [];
  events = [];
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('runScheduleTick', () => {
  describe('initialize', () => {
    it('gives a scheduler without next_run_at the first time after now, expecting null', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T00:00:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([
        mockSchedulerRow({ id: SCHEDULER_ID, cron_expression: '0 7 * * *' }),
        mockSchedulerRow({ id: SCHEDULER_ID_2, cron_expression: 'not a cron' }),
      ]);
      mockSetSchedulerNextRuns();
      mockListSchedulersDue([]);

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result).toEqual({ interrupted: 0, initialized: 1, started: 0 });

      const listRequest = requestsOf('GET', 'schedulers')[0];
      expect(listRequest.query).toContain('next_run_at=is.null');
      expect(listRequest.query).toContain('limit=500');

      // The scheduler whose cron cannot be parsed is not touched
      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(updateRequests[0].body).toEqual({
        updates: [
          { id: SCHEDULER_ID, expected_next_run_at: null, next_run_at: '2026-10-05T22:00:00.000Z' },
        ],
      });

      expect(workflow.createBatch).not.toHaveBeenCalled();
      fetchMock.assertNoPendingInterceptors();
    });

    it('sends the schedulers of a page in one request and counts the IDs it returns', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T00:00:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([
        mockSchedulerRow({ id: SCHEDULER_ID, cron_expression: '0 7 * * *' }),
        mockSchedulerRow({ id: SCHEDULER_ID_2, cron_expression: '30 9 * * *' }),
        mockSchedulerRow({ id: SCHEDULER_ID_3, cron_expression: '0 7 * * *' }),
      ]);
      // The second scheduler got a next run in the meantime, so it does not change
      mockSetSchedulerNextRuns(1, (updates) => updates.map((update) => update.id).filter((id) => id !== SCHEDULER_ID_2));
      mockListSchedulersDue([]);

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result).toEqual({ interrupted: 0, initialized: 2, started: 0 });

      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual([
        { id: SCHEDULER_ID, expected_next_run_at: null, next_run_at: '2026-10-05T22:00:00.000Z' },
        { id: SCHEDULER_ID_2, expected_next_run_at: null, next_run_at: '2026-10-05T00:30:00.000Z' },
        { id: SCHEDULER_ID_3, expected_next_run_at: null, next_run_at: '2026-10-05T22:00:00.000Z' },
      ]);
      fetchMock.assertNoPendingInterceptors();
    });
  });

  describe('initialize pages', () => {
    const now = new Date('2026-10-05T00:00:00.000Z');

    function cursorOf(scheduler: { created_at: string; id: string }): string {
      return `or=(created_at.gt."${scheduler.created_at}",and(created_at.eq."${scheduler.created_at}",id.gt.${scheduler.id}))`;
    }

    it('initializes a normal row behind a full page of rows whose next run cannot be computed', async () => {
      const workflow = createFakeWorkflow();
      const dependencies = createDependencies(workflow);
      const firstPage = schedulerPage(0, 'not a cron');
      const normalScheduler = mockSchedulerRow({
        id: SCHEDULER_ID_2,
        cron_expression: '0 7 * * *',
        created_at: '2026-01-02T00:00:00+00:00',
      });

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun(firstPage);
      mockListSchedulersWithoutNextRun([normalScheduler]);
      mockSetSchedulerNextRuns();
      mockListSchedulersDue([]);

      const result = await runScheduleTick(dependencies, now);

      expect(result).toEqual({ interrupted: 0, initialized: 1, started: 0 });

      const listRequests = requestsOf('GET', 'schedulers').filter((request) => request.query.includes('next_run_at=is.null'));
      expect(listRequests).toHaveLength(2);
      expect(listRequests[0].query).not.toContain('or=');
      expect(listRequests[0].query).toContain('order=created_at.asc,id.asc');
      expect(listRequests[0].query).toContain('limit=500');
      // The second page starts strictly after the last row of the first page
      expect(listRequests[1].query).toContain(cursorOf(firstPage[499]));
      expect(listRequests[1].query).toContain('order=created_at.asc,id.asc');
      expect(listRequests[1].query).toContain('limit=500');

      // The first page has nothing to send, so only the second page sends a request
      expect(supabaseRequests.map((request) => `${request.method} ${request.table}`)).toEqual([
        'GET scheduler_runs',
        'GET schedulers',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
      ]);
      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual([
        { id: SCHEDULER_ID_2, expected_next_run_at: null, next_run_at: '2026-10-05T22:00:00.000Z' },
      ]);

      // The rows left without a next run are logged once, as a count
      expect(dependencies.logger.warn).toHaveBeenCalledTimes(1);
      expect(dependencies.logger.warn).toHaveBeenCalledWith(
        'Schedulers whose next run cannot be computed',
        { count: 500 },
        { function: 'runScheduleTick' },
      );
      fetchMock.assertNoPendingInterceptors();
    });

    it('sends one request per page', async () => {
      const workflow = createFakeWorkflow();
      const firstPage = schedulerPage(0, '0 7 * * *');
      const normalScheduler = mockSchedulerRow({
        id: SCHEDULER_ID_2,
        cron_expression: '0 7 * * *',
        created_at: '2026-01-02T00:00:00+00:00',
      });

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun(firstPage);
      mockListSchedulersWithoutNextRun([normalScheduler]);
      mockSetSchedulerNextRuns(2);
      mockListSchedulersDue([]);

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result).toEqual({ interrupted: 0, initialized: 501, started: 0 });

      // Each page is sent right after it is read
      expect(supabaseRequests.map((request) => `${request.method} ${request.table}`)).toEqual([
        'GET scheduler_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
      ]);

      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(2);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual(firstPage.map((scheduler) => ({
        id: scheduler.id,
        expected_next_run_at: null,
        next_run_at: '2026-10-05T22:00:00.000Z',
      })));
      expect(nextRunUpdatesOf(updateRequests[1])).toEqual([
        { id: SCHEDULER_ID_2, expected_next_run_at: null, next_run_at: '2026-10-05T22:00:00.000Z' },
      ]);
      fetchMock.assertNoPendingInterceptors();
    });

    it('reads no more than 4 pages in one tick', async () => {
      const workflow = createFakeWorkflow();
      const dependencies = createDependencies(workflow);
      const pages = [0, 1, 2, 3].map((page) => schedulerPage(page, 'not a cron'));

      mockListActiveRuns([]);
      for (const page of pages) {
        mockListSchedulersWithoutNextRun(page);
      }
      mockListSchedulersDue([]);

      const result = await runScheduleTick(dependencies, now);

      expect(result).toEqual({ interrupted: 0, initialized: 0, started: 0 });

      const listRequests = requestsOf('GET', 'schedulers').filter((request) => request.query.includes('next_run_at=is.null'));
      expect(listRequests).toHaveLength(4);
      expect(listRequests[0].query).not.toContain('or=');
      for (let page = 1; page < 4; page++) {
        expect(listRequests[page].query).toContain(cursorOf(pages[page - 1][499]));
      }

      // The fifth request is the due list, not another page
      expect(supabaseRequests.map((request) => `${request.method} ${request.table}`)).toEqual([
        'GET scheduler_runs',
        'GET schedulers',
        'GET schedulers',
        'GET schedulers',
        'GET schedulers',
        'GET schedulers',
      ]);
      expect(supabaseRequests[5].query).toContain('next_run_at=lte.');
      expect(setSchedulerNextRunsRequests()).toHaveLength(0);

      expect(dependencies.logger.warn).toHaveBeenCalledTimes(1);
      expect(dependencies.logger.warn).toHaveBeenCalledWith(
        'Schedulers whose next run cannot be computed',
        { count: 2000 },
        { function: 'runScheduleTick' },
      );
      fetchMock.assertNoPendingInterceptors();
    });
  });

  describe('start', () => {
    it('creates the instance of a due occurrence, then moves next_run_at to the next day', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T22:00:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([
        mockSchedulerRow({ cron_expression: '0 7 * * *', next_run_at: '2026-10-05T22:00:00.000Z' }),
      ]);
      mockSetSchedulerNextRuns();

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result).toEqual({ interrupted: 0, initialized: 0, started: 1 });

      const dueRequest = requestsOf('GET', 'schedulers')[1];
      expect(dueRequest.query).toContain('next_run_at=lte.2026-10-05T22:00:00.000Z');
      expect(dueRequest.query).toContain('limit=500');

      expect(workflow.createBatch).toHaveBeenCalledTimes(1);
      expect(workflow.createBatch).toHaveBeenCalledWith([
        {
          id: `${SCHEDULER_ID}-29853960`,
          params: { schedulerID: SCHEDULER_ID, scheduledFor: '2026-10-05T22:00:00.000Z' },
        },
      ]);

      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(updateRequests[0].body).toEqual({
        updates: [
          {
            id: SCHEDULER_ID,
            expected_next_run_at: '2026-10-05T22:00:00.000Z',
            next_run_at: '2026-10-06T22:00:00.000Z',
          },
        ],
      });

      expect(events).toEqual(['createBatch:1', 'setSchedulerNextRuns:1']);
      fetchMock.assertNoPendingInterceptors();
    });

    it('sends next_run_at back as the expected value exactly as Supabase returned it', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T22:00:00.000Z');
      // PostgREST returns timestamptz with an offset and, when stored, microseconds. A value rebuilt
      // through Date would lose the microseconds and no longer match the stored one.
      const storedNextRunAt = '2026-10-05T22:00:00.000001+00:00';

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([
        mockSchedulerRow({ cron_expression: '0 7 * * *', next_run_at: storedNextRunAt }),
      ]);
      mockSetSchedulerNextRuns();

      await runScheduleTick(createDependencies(workflow), now);

      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual([
        {
          id: SCHEDULER_ID,
          expected_next_run_at: storedNextRunAt,
          next_run_at: '2026-10-06T22:00:00.000Z',
        },
      ]);
      fetchMock.assertNoPendingInterceptors();
    });

    it('runs an occurrence the tick reaches late as its own occurrence', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T00:10:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([
        mockSchedulerRow({ cron_expression: '5 9 * * *', next_run_at: '2026-10-05T00:05:00.000Z' }),
      ]);
      mockSetSchedulerNextRuns();

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result.started).toBe(1);
      expect(workflow.createBatch).toHaveBeenCalledTimes(1);
      expect(workflow.createBatch).toHaveBeenCalledWith([
        {
          id: `${SCHEDULER_ID}-29852645`,
          params: { schedulerID: SCHEDULER_ID, scheduledFor: '2026-10-05T00:05:00.000Z' },
        },
      ]);

      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual([
        {
          id: SCHEDULER_ID,
          expected_next_run_at: '2026-10-05T00:05:00.000Z',
          next_run_at: '2026-10-06T00:05:00.000Z',
        },
      ]);
      fetchMock.assertNoPendingInterceptors();
    });

    it('calls createBatch 100 at a time for 250 due schedulers, then moves all 250 in one request', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T22:00:00.000Z');
      const schedulers = dueSchedulers(250, '2026-10-05T22:00:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue(schedulers);
      mockSetSchedulerNextRuns();

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result.started).toBe(250);
      expect(workflow.createBatch).toHaveBeenCalledTimes(3);
      expect(workflow.createBatch.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);

      const instanceIDs = workflow.createBatch.mock.calls.flatMap(([batch]) => batch.map((options) => options.id));
      expect(instanceIDs).toEqual(schedulers.map((scheduler) => `${scheduler.id}-29853960`));

      // next_run_at moves only after every createBatch has returned, in exactly one request
      expect(events).toEqual(['createBatch:100', 'createBatch:100', 'createBatch:50', 'setSchedulerNextRuns:250']);

      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(1);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual(schedulers.map((scheduler) => ({
        id: scheduler.id,
        expected_next_run_at: '2026-10-05T22:00:00.000Z',
        next_run_at: '2026-10-06T22:00:00.000Z',
      })));
      expect(supabaseRequests.filter((request) => request.method === 'PATCH')).toHaveLength(0);
      fetchMock.assertNoPendingInterceptors();
    });

    it('throws and moves no next_run_at when createBatch throws', async () => {
      const workflow = createFakeWorkflow();
      workflow.createBatch.mockRejectedValueOnce(new Error('createBatch failed'));
      const now = new Date('2026-10-05T22:00:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([
        mockSchedulerRow({ next_run_at: '2026-10-05T22:00:00.000Z' }),
      ]);

      await expect(runScheduleTick(createDependencies(workflow), now)).rejects.toThrow('createBatch failed');

      expect(workflow.createBatch).toHaveBeenCalledTimes(1);
      expect(setSchedulerNextRunsRequests()).toHaveLength(0);
      fetchMock.assertNoPendingInterceptors();
    });

    it('does not call createBatch when no scheduler is due', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T22:00:00.000Z');

      mockListActiveRuns([]);
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([]);

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result).toEqual({ interrupted: 0, initialized: 0, started: 0 });
      expect(workflow.createBatch).not.toHaveBeenCalled();
      expect(setSchedulerNextRunsRequests()).toHaveLength(0);
      fetchMock.assertNoPendingInterceptors();
    });
  });

  describe('clean up', () => {
    const now = new Date('2026-10-05T22:00:00.000Z');
    const scheduledRun = mockRunRow({
      id: '00000000-0000-0000-0000-000000000041',
      triggered_by: 'schedule',
      scheduled_for: '2026-10-05T21:00:00.000Z',
    });
    const scheduledRunInstanceID = instanceIDOf(SCHEDULER_ID, '2026-10-05T21:00:00.000Z');

    function mockEmptyStartSteps() {
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([]);
    }

    it('reads active runs created more than 10 minutes ago, 200 at most', async () => {
      const workflow = createFakeWorkflow();

      mockListActiveRuns([]);
      mockEmptyStartSteps();

      await runScheduleTick(createDependencies(workflow), now);

      const listRequest = requestsOf('GET', 'scheduler_runs')[0];
      expect(listRequest.query).toContain('status=in.(pending,running)');
      expect(listRequest.query).toContain('created_at=lt.2026-10-05T21:50:00.000Z');
      expect(listRequest.query).toContain('limit=200');
      expect(failSchedulerRunsRequests()).toHaveLength(0);
      fetchMock.assertNoPendingInterceptors();
    });

    it('fails a manual run', async () => {
      const workflow = createFakeWorkflow();
      const manualRun = mockRunRow({ triggered_by: 'manual', scheduled_for: null });

      mockListActiveRuns([manualRun]);
      mockFailSchedulerRuns();
      mockEmptyStartSteps();

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result.interrupted).toBe(1);
      expect(workflow.get).not.toHaveBeenCalled();

      const failRequests = failSchedulerRunsRequests();
      expect(failRequests).toHaveLength(1);
      expect(failRequests[0].body).toEqual({
        run_ids: [manualRun.id],
        failed_at: '2026-10-05T22:00:00.000Z',
        failure_message: 'Run was interrupted',
      });
      fetchMock.assertNoPendingInterceptors();
    });

    it.each(['running', 'waiting'] as const)('leaves a run alone whose instance is %s', async (status) => {
      const workflow = createFakeWorkflow({ [scheduledRunInstanceID]: status });

      mockListActiveRuns([scheduledRun]);
      mockEmptyStartSteps();

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result.interrupted).toBe(0);
      expect(workflow.get).toHaveBeenCalledWith(scheduledRunInstanceID);
      expect(failSchedulerRunsRequests()).toHaveLength(0);
      fetchMock.assertNoPendingInterceptors();
    });

    it.each([
      ['whose instance is errored', { [scheduledRunInstanceID]: 'errored' as const }],
      ['whose instance get throws for', {}],
    ])('fails a run %s', async (_, instanceStatuses) => {
      const workflow = createFakeWorkflow(instanceStatuses);

      mockListActiveRuns([scheduledRun]);
      mockFailSchedulerRuns();
      mockEmptyStartSteps();

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result.interrupted).toBe(1);
      expect(workflow.get).toHaveBeenCalledWith(scheduledRunInstanceID);

      const failRequests = failSchedulerRunsRequests();
      expect(failRequests).toHaveLength(1);
      expect(failRequests[0].body).toEqual({
        run_ids: [scheduledRun.id],
        failed_at: '2026-10-05T22:00:00.000Z',
        failure_message: 'Run was interrupted',
      });
      fetchMock.assertNoPendingInterceptors();
    });

    it('fails every interrupted run in one request and counts the IDs it returns', async () => {
      const manualRun = mockRunRow({
        id: '00000000-0000-0000-0000-000000000042',
        triggered_by: 'manual',
        scheduled_for: null,
      });
      const missingInstanceRun = mockRunRow({
        id: '00000000-0000-0000-0000-000000000043',
        scheduler_id: SCHEDULER_ID_2,
        triggered_by: 'schedule',
        scheduled_for: '2026-10-05T20:00:00.000Z',
      });
      const liveRun = mockRunRow({
        id: '00000000-0000-0000-0000-000000000044',
        scheduler_id: SCHEDULER_ID_3,
        triggered_by: 'schedule',
        scheduled_for: '2026-10-05T21:00:00.000Z',
      });
      const workflow = createFakeWorkflow({
        [scheduledRunInstanceID]: 'errored',
        [instanceIDOf(SCHEDULER_ID_3, '2026-10-05T21:00:00.000Z')]: 'running',
      });
      const dependencies = createDependencies(workflow);

      mockListActiveRuns([scheduledRun, manualRun, missingInstanceRun, liveRun]);
      // The manual run finished in the meantime, so it does not change
      mockFailSchedulerRuns((runIDs) => runIDs.filter((runID) => runID !== manualRun.id));
      mockEmptyStartSteps();

      const result = await runScheduleTick(dependencies, now);

      expect(result.interrupted).toBe(2);

      const failRequests = failSchedulerRunsRequests();
      expect(failRequests).toHaveLength(1);
      expect(failRequests[0].body).toEqual({
        run_ids: [scheduledRun.id, manualRun.id, missingInstanceRun.id],
        failed_at: '2026-10-05T22:00:00.000Z',
        failure_message: 'Run was interrupted',
      });

      // Only the runs the request changed are logged
      const failedRunLogs = vi.mocked(dependencies.logger.warn).mock.calls
        .filter(([message]) => message === 'Interrupted run failed');
      expect(failedRunLogs.map(([, context]) => (context as { runID: string }).runID)).toEqual([
        scheduledRun.id,
        missingInstanceRun.id,
      ]);
      fetchMock.assertNoPendingInterceptors();
    });

    it('leaves a run alone whose instance status() throws, and the tick goes on', async () => {
      const workflow = createFakeWorkflow({ [scheduledRunInstanceID]: new Error('status unavailable') });
      const dependencies = createDependencies(workflow);
      const manualRun = mockRunRow({
        id: '00000000-0000-0000-0000-000000000042',
        triggered_by: 'manual',
        scheduled_for: null,
      });

      mockListActiveRuns([scheduledRun, manualRun]);
      mockFailSchedulerRuns();
      mockListSchedulersWithoutNextRun([
        mockSchedulerRow({ id: SCHEDULER_ID_2, cron_expression: '0 7 * * *' }),
      ]);
      mockSetSchedulerNextRuns(2);
      mockListSchedulersDue([
        mockSchedulerRow({ cron_expression: '0 7 * * *', next_run_at: '2026-10-05T22:00:00.000Z' }),
      ]);

      const result = await runScheduleTick(dependencies, now);

      expect(result).toEqual({ interrupted: 1, initialized: 1, started: 1 });
      expect(workflow.get).toHaveBeenCalledWith(scheduledRunInstanceID);

      // Only the next run, the manual one, is failed
      const failRequests = failSchedulerRunsRequests();
      expect(failRequests).toHaveLength(1);
      expect(failRequests[0].body?.run_ids).toEqual([manualRun.id]);

      expect(dependencies.logger.warn).toHaveBeenCalledWith(
        'Run instance status could not be read',
        { schedulerID: SCHEDULER_ID, runID: scheduledRun.id, error: 'status unavailable' },
        { function: 'runScheduleTick' },
      );

      // Initialize and start still happen in the same tick
      const updateRequests = setSchedulerNextRunsRequests();
      expect(updateRequests).toHaveLength(2);
      expect(nextRunUpdatesOf(updateRequests[0])).toEqual([
        { id: SCHEDULER_ID_2, expected_next_run_at: null, next_run_at: '2026-10-06T22:00:00.000Z' },
      ]);
      expect(workflow.createBatch).toHaveBeenCalledTimes(1);
      expect(workflow.createBatch).toHaveBeenCalledWith([
        {
          id: `${SCHEDULER_ID}-29853960`,
          params: { schedulerID: SCHEDULER_ID, scheduledFor: '2026-10-05T22:00:00.000Z' },
        },
      ]);
      expect(nextRunUpdatesOf(updateRequests[1])).toEqual([
        {
          id: SCHEDULER_ID,
          expected_next_run_at: '2026-10-05T22:00:00.000Z',
          next_run_at: '2026-10-06T22:00:00.000Z',
        },
      ]);
      fetchMock.assertNoPendingInterceptors();
    });

    it('cleans up before it initializes and starts', async () => {
      const workflow = createFakeWorkflow();

      mockListActiveRuns([mockRunRow()]);
      mockFailSchedulerRuns();
      mockListSchedulersWithoutNextRun([]);
      mockListSchedulersDue([]);

      await runScheduleTick(createDependencies(workflow), now);

      expect(supabaseRequests.map((request) => `${request.method} ${request.table}`)).toEqual([
        'GET scheduler_runs',
        'POST rpc/fail_scheduler_runs',
        'GET schedulers',
        'GET schedulers',
      ]);
      expect(supabaseRequests[2].query).toContain('next_run_at=is.null');
      expect(supabaseRequests[3].query).toContain('next_run_at=lte.');
      fetchMock.assertNoPendingInterceptors();
    });
  });

  describe('request count', () => {
    // Every fetch the Supabase client makes, whether an interceptor matched it or not
    let fetchSpy: MockInstance<typeof fetch>;

    function supabaseFetchCount(): number {
      return fetchSpy.mock.calls.filter(([input]) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.startsWith(SUPABASE_ORIGIN);
      }).length;
    }

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('sends at most 12 Supabase requests with 250 due schedulers, full initialize pages and runs to close', async () => {
      const workflow = createFakeWorkflow();
      const now = new Date('2026-10-05T22:00:00.000Z');
      // The most each step reads: 200 runs to close, 4 full initialize pages, then 250 due schedulers
      const runs = Array.from({ length: 200 }, (_, index) => mockRunRow({
        id: `00000000-0000-0000-0001-${String(index).padStart(12, '0')}`,
        triggered_by: 'manual',
        scheduled_for: null,
      }));
      const pages = [0, 1, 2, 3].map((page) => schedulerPage(page, '0 7 * * *'));
      const schedulers = dueSchedulers(250, '2026-10-05T22:00:00.000Z');

      mockListActiveRuns(runs);
      mockFailSchedulerRuns();
      for (const page of pages) {
        mockListSchedulersWithoutNextRun(page);
      }
      mockSetSchedulerNextRuns(5);
      mockListSchedulersDue(schedulers);

      const result = await runScheduleTick(createDependencies(workflow), now);

      expect(result).toEqual({ interrupted: 200, initialized: 2000, started: 250 });

      expect(supabaseFetchCount()).toBeLessThanOrEqual(12);
      expect(supabaseFetchCount()).toBe(supabaseRequests.length);
      expect(supabaseRequests.map((request) => `${request.method} ${request.table}`)).toEqual([
        'GET scheduler_runs',
        'POST rpc/fail_scheduler_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
        'GET schedulers',
        'POST rpc/set_scheduler_next_runs',
      ]);

      // Each request carries all of its step's rows
      expect(failSchedulerRunsRequests()[0].body?.run_ids).toHaveLength(200);
      expect(setSchedulerNextRunsRequests().map((request) => nextRunUpdatesOf(request).length)).toEqual([500, 500, 500, 500, 250]);
      expect(events).toEqual([
        'failSchedulerRuns:200',
        'setSchedulerNextRuns:500',
        'setSchedulerNextRuns:500',
        'setSchedulerNextRuns:500',
        'setSchedulerNextRuns:500',
        'createBatch:100',
        'createBatch:100',
        'createBatch:50',
        'setSchedulerNextRuns:250',
      ]);
      fetchMock.assertNoPendingInterceptors();
    });
  });
});
