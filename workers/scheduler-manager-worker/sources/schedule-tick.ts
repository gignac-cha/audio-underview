import type { Logger } from '@audio-underview/logger';
import {
  type SupabaseClient,
  type SchedulerRunRow,
  listActiveSchedulerRunsBefore,
  listSchedulersWithoutNextRun,
  listSchedulersDue,
  setSchedulerNextRun,
  updateSchedulerRun,
} from '@audio-underview/supabase-connector';
import { resolveNextRunAt, schedulerRunInstanceID } from './schedule.ts';
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

// A manual run lasts at most 5 minutes, so an active run older than this was interrupted
// unless its Workflow instance is still alive.
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

  if (run.triggered_by !== 'schedule' || run.scheduled_for === null) return false;

  let instance: WorkflowInstance;
  try {
    instance = await workflow.get(schedulerRunInstanceID(run.scheduler_id, new Date(run.scheduled_for)));
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

  let interrupted = 0;
  for (const run of runs) {
    if (await isRunInstanceAlive(dependencies, run)) continue;

    // The status condition keeps a run that finished in the meantime as it is
    const updatedRun = await updateSchedulerRun(supabaseClient, run.id, run.scheduler_id, {
      status: 'failed',
      completed_at: now.toISOString(),
      error: 'Run was interrupted',
    }, { onlyIfStatus: ['pending', 'running'] });

    if (updatedRun !== undefined) {
      interrupted++;
      logger.warn('Interrupted run failed', {
        schedulerID: run.scheduler_id,
        runID: run.id,
        triggeredBy: run.triggered_by,
      }, { function: 'runScheduleTick' });
    }
  }
  return interrupted;
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

    for (const scheduler of schedulers) {
      const nextRunAt = resolveNextRunAt(scheduler, now);
      if (nextRunAt === null) {
        unresolved++;
        continue;
      }

      if (await setSchedulerNextRun(supabaseClient, scheduler.id, null, nextRunAt)) {
        initialized++;
      }
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
 * Creates one Workflow instance per due scheduler, then moves each next run past `now`.
 * The instances are created first: a failure in between leaves next_run_at as it was,
 * and the next tick asks for the same instance IDs, which createBatch skips.
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
  for (const scheduler of schedulers) {
    await setSchedulerNextRun(supabaseClient, scheduler.id, scheduler.next_run_at, resolveNextRunAt(scheduler, now));
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
