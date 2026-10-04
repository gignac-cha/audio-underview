import type { Logger } from '@audio-underview/logger';
import {
  type SupabaseClient,
  type SchedulerRunRow,
  type SchedulerNextRunUpdate,
  listActiveSchedulerRunsBefore,
  listSchedulersWithoutNextRun,
  listSchedulersDue,
  setSchedulerNextRuns,
  failSchedulerRuns,
} from '@audio-underview/supabase-connector';
import { resolveNextRunAt, runInstanceID, schedulerRunInstanceID } from './schedule.ts';
import type { SchedulerRunParameters } from './scheduler-run-workflow.ts';

export interface ScheduleTickDependencies {
  supabaseClient: SupabaseClient;
  workflow: Pick<Workflow, 'createBatch' | 'get'>;
  logger: Logger;
}

export interface ScheduleTickResult {
  interrupted: number;
  initialized: number;
  started: number;
}

// Workers Free allows 50 external subrequests per invocation, so each step sends its
// Supabase changes in one request instead of one per row: a tick makes at most
// 12 Supabase requests, whatever the number of schedulers.

// A manual run executed inside its request lasts at most 5 minutes, so an active run older
// than this was interrupted unless its Workflow instance is still alive.
const INTERRUPTED_RUN_AGE_MILLISECONDS = 10 * 60 * 1000;
const INTERRUPTED_RUN_LIMIT = 200;
const INITIALIZE_PAGE_SIZE = 500;
// Rows whose next run cannot be computed stay without one and are read again on every tick,
// so later pages are read as well, up to 2,000 rows per tick.
const INITIALIZE_PAGE_LIMIT = 4;
const DUE_LIMIT = 500;
// createBatch accepts at most 100 instances per call.
const CREATE_BATCH_SIZE = 100;

const LIVE_INSTANCE_STATUSES: ReadonlySet<InstanceStatus['status']> = new Set<InstanceStatus['status']>([
  'queued',
  'running',
  'paused',
  'waiting',
  'waitingForPause',
  'unknown',
]);

async function isRunInstanceAlive(
  dependencies: ScheduleTickDependencies,
  run: SchedulerRunRow,
): Promise<boolean> {
  const { workflow, logger } = dependencies;

  let instance: WorkflowInstance;
  try {
    // A manual run executed inside its request has no instance, so get throws for it
    instance = await workflow.get(runInstanceID(run));
  } catch {
    // get throws when the instance does not exist
    return false;
  }

  try {
    const { status } = await instance.status();
    return LIVE_INSTANCE_STATUSES.has(status);
  } catch (error) {
    // The state is unknown, so the run is left alone like an 'unknown' instance
    logger.warn('Run instance status could not be read', {
      schedulerID: run.scheduler_id,
      runID: run.id,
      error: error instanceof Error ? error.message : String(error),
    }, { function: 'runScheduleTick' });
    return true;
  }
}

/**
 * Fails active runs that are left over from an interrupted execution, so they
 * do not make every later occurrence skip.
 *
 * @returns the number of runs changed
 */
async function failInterruptedRuns(dependencies: ScheduleTickDependencies, now: Date): Promise<number> {
  const { supabaseClient, logger } = dependencies;

  const createdBefore = new Date(now.getTime() - INTERRUPTED_RUN_AGE_MILLISECONDS).toISOString();
  const runs = await listActiveSchedulerRunsBefore(supabaseClient, createdBefore, INTERRUPTED_RUN_LIMIT);

  const interruptedRuns: SchedulerRunRow[] = [];
  for (const run of runs) {
    if (await isRunInstanceAlive(dependencies, run)) continue;
    interruptedRuns.push(run);
  }

  if (interruptedRuns.length === 0) return 0;

  // One request for every run; only runs still pending or running change,
  // so a run that finished in the meantime keeps its result
  const failedRunIDs = await failSchedulerRuns(
    supabaseClient,
    interruptedRuns.map((run) => run.id),
    now.toISOString(),
    'Run was interrupted',
  );

  const failedRunIDSet = new Set(failedRunIDs);
  for (const run of interruptedRuns) {
    if (!failedRunIDSet.has(run.id)) continue;
    logger.warn('Interrupted run failed', {
      schedulerID: run.scheduler_id,
      runID: run.id,
      triggeredBy: run.triggered_by,
    }, { function: 'runScheduleTick' });
  }
  return failedRunIDs.length;
}

/**
 * Gives enabled schedulers without a next run (saved before scheduled runs existed) their first one.
 * Nothing runs in this step.
 *
 * @returns the number of schedulers changed
 */
async function initializeNextRuns(dependencies: ScheduleTickDependencies, now: Date): Promise<number> {
  const { supabaseClient, logger } = dependencies;

  let initialized = 0;
  let unresolved = 0;
  let after: { created_at: string; id: string } | undefined;
  for (let page = 0; page < INITIALIZE_PAGE_LIMIT; page++) {
    const schedulers = await listSchedulersWithoutNextRun(supabaseClient, INITIALIZE_PAGE_SIZE, after);

    const updates: SchedulerNextRunUpdate[] = [];
    for (const scheduler of schedulers) {
      const nextRunAt = resolveNextRunAt(scheduler, now);
      if (nextRunAt === null) {
        unresolved++;
        continue;
      }
      updates.push({ id: scheduler.id, expected: null, next: nextRunAt });
    }

    // One request per page
    if (updates.length > 0) {
      const initializedIDs = await setSchedulerNextRuns(supabaseClient, updates);
      initialized += initializedIDs.length;
    }

    // A page that is not full is the last one
    if (schedulers.length < INITIALIZE_PAGE_SIZE) break;

    const lastScheduler = schedulers[schedulers.length - 1];
    after = { created_at: lastScheduler.created_at, id: lastScheduler.id };
  }

  if (unresolved > 0) {
    logger.warn('Schedulers whose next run cannot be computed', {
      count: unresolved,
    }, { function: 'runScheduleTick' });
  }
  return initialized;
}

/**
 * Creates one Workflow instance per due scheduler, then moves each next run past `now`
 * in one request. The instances are created first: a failure in between leaves
 * next_run_at as it was, and the next tick asks for the same instance IDs, which
 * createBatch skips.
 *
 * @returns the number of instances requested
 */
async function startDueSchedulers(dependencies: ScheduleTickDependencies, now: Date): Promise<number> {
  const { supabaseClient, workflow } = dependencies;

  const schedulers = await listSchedulersDue(supabaseClient, now.toISOString(), DUE_LIMIT);

  const instances = schedulers.map((scheduler): WorkflowInstanceCreateOptions<SchedulerRunParameters> => {
    // listSchedulersDue only returns schedulers whose next_run_at is set
    const scheduledFor = new Date(scheduler.next_run_at!);
    return {
      id: schedulerRunInstanceID(scheduler.id, scheduledFor),
      params: { schedulerID: scheduler.id, scheduledFor: scheduledFor.toISOString() },
    };
  });

  for (let index = 0; index < instances.length; index += CREATE_BATCH_SIZE) {
    await workflow.createBatch(instances.slice(index, index + CREATE_BATCH_SIZE));
  }

  // One occurrence per tick: missed occurrences are not caught up
  if (schedulers.length > 0) {
    await setSchedulerNextRuns(supabaseClient, schedulers.map((scheduler) => ({
      id: scheduler.id,
      expected: scheduler.next_run_at,
      next: resolveNextRunAt(scheduler, now),
    })));
  }

  return instances.length;
}

/**
 * One run of the 10-minute cron trigger: clean up interrupted runs, initialize
 * next runs, then start the schedulers that are due, in this order.
 *
 * @param now - the scheduled time of the cron trigger
 */
export async function runScheduleTick(dependencies: ScheduleTickDependencies, now: Date): Promise<ScheduleTickResult> {
  const interrupted = await failInterruptedRuns(dependencies, now);
  const initialized = await initializeNextRuns(dependencies, now);
  const started = await startDueSchedulers(dependencies, now);

  return { interrupted, initialized, started };
}
