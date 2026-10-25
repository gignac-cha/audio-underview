import { WorkerEntrypoint } from 'cloudflare:workers';
import { createWorkerLogger } from '@audio-underview/logger';
import { pickRandomDialogueVoices } from '@audio-underview/newscast-tts';
import type { SupabaseClient } from '@audio-underview/supabase-connector';
import { resolveCustomArticleDetails } from './custom-article.ts';
import type { Environment, NewscastWorkflowParameters, TaskGroupProgressReport } from './environment.ts';
import {
  createNewscastSupabaseClient,
  insertNewscastsOfStageRun,
  listNewscastsOfStageRun,
  resolveNewscastTitle,
  type NewscastInsert,
  type NewscastRow,
} from './storage.ts';
import {
  buildNewscastRequest,
  parseNewscastStart,
  titleOfSource,
  type NewscastSource,
} from './task-group-input.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-worker-task-group' },
});

/**
 * What the scheduler sends to start the group for one stage run (`TaskGroupStartRequest` of
 * scheduler-manager-worker `task-group-worker.ts`).
 */
export interface TaskGroupStartRequest {
  /** Identifies this stage run in every report. Starting twice with the same value must not run the group twice. */
  stageRunID: string;
  taskGroupID: string;
  taskGroupVersion: number;
  /** Output of the previous stage, already checked against the input schema */
  input: unknown;
  /** Settings saved on the stage, valid for the settings schema */
  settings: Record<string, unknown>;
  /** Owner of the scheduler */
  userUUID: string;
}

/** The output of the group, as the registered output schema describes it (migration 016). */
export interface NewscastTaskGroupOutput {
  newscasts: Array<{ id: string; status: 'done' | 'error'; title: string | null }>;
}

/** The report the rows of a stage run call for. */
export type StageRunReport =
  | { kind: 'progress'; progress: TaskGroupProgressReport }
  | { kind: 'complete'; output: NewscastTaskGroupOutput }
  | { kind: 'fail'; errorMessage: string };

/** Code of the createBatch error for an instance id that already exists */
const INSTANCE_ALREADY_EXISTS_CODE = 10405;

/** The Workflow instance id of one newscast: the stage run and the position of the source in it. */
export function newscastInstanceID(stageRunID: string, sourceIndex: number): string {
  return `${stageRunID}-${sourceIndex}`;
}

/**
 * What to tell the scheduler about a stage run, from all of its newscasts:
 * - all finished and at least one done: complete, with every newscast in source order
 * - all failed: fail, with the first error
 * - otherwise: how many of them are finished
 */
export function summarizeStageRun(rows: NewscastRow[]): StageRunReport {
  const total = rows.length;
  const finished = rows.filter((row) => row.status !== 'running');
  if (finished.length < total || total === 0) {
    return {
      kind: 'progress',
      progress: { message: `${finished.length} of ${total} newscasts finished`, completed: finished.length, total },
    };
  }
  if (rows.some((row) => row.status === 'done')) {
    return {
      kind: 'complete',
      output: {
        newscasts: rows.map((row) => ({
          id: row.id,
          status: row.status === 'done' ? 'done' : 'error',
          title: resolveNewscastTitle(row),
        })),
      },
    };
  }
  const firstError = rows.find((row) => row.error !== null && row.error.length > 0)?.error ?? 'no error was recorded';
  return { kind: 'fail', errorMessage: `All ${total} newscasts failed: ${firstError}` };
}

/**
 * Read every newscast of the stage run and send the report they call for (design §1).
 *
 * Two newscasts that finish at the same moment may both find the stage run finished and both
 * report it: the scheduler accepts one report per stage run, and answers the second the same way.
 * A report the scheduler refuses with a TypeError has wrong arguments, so it is logged instead of
 * sent again; any other failure throws, so the step that called this retries it.
 */
export async function reportStageRun(
  environment: Environment,
  client: SupabaseClient,
  stageRunID: string,
): Promise<StageRunReport> {
  const report = summarizeStageRun(await listNewscastsOfStageRun(client, stageRunID));
  const reports = environment.SCHEDULER_TASK_GROUP_REPORTS;
  try {
    const result =
      report.kind === 'progress'
        ? await reports.reportProgress(stageRunID, report.progress)
        : report.kind === 'complete'
          ? await reports.complete(stageRunID, report.output)
          : await reports.fail(stageRunID, report.errorMessage);
    if (!result.accepted) {
      logger.info('The scheduler did not accept the report; the stage run ended otherwise', {
        stageRunID,
        report: report.kind,
      }, { function: 'reportStageRun' });
    }
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    logger.error('The scheduler refused the arguments of a report', error, {
      function: 'reportStageRun',
      metadata: { stageRunID, report: report.kind },
    });
  }
  return report;
}

function insertOfSource(
  source: NewscastSource,
  sourceIndex: number,
  stageRunID: string,
  userUUID: string,
  request: NewscastInsert['request'],
): NewscastInsert {
  return {
    user_uuid: userUUID,
    stage_run_id: stageRunID,
    source_index: sourceIndex,
    status: 'running',
    stage: 'crawl-list',
    stage_progress: 0,
    overall_progress: 0,
    title: titleOfSource(source),
    request,
    // The EXPLICIT source flag (verbatim design §3/§5), for every pasted newscast whether or not
    // it is verbatim; for a verbatim one it also carries the part count, known before the run
    details: source.kind === 'text' ? { customArticle: resolveCustomArticleDetails(source.customArticle) } : {},
  };
}

/**
 * The entrypoint the scheduler starts the task group "newscast" through (`NEWSCAST` binding of
 * scheduler-manager-worker).
 */
export class NewscastTaskGroup extends WorkerEntrypoint<Environment> {
  /**
   * Make one newscast per source of the input: a `newscasts` row and a Workflow instance each, then
   * return, well within the time the scheduler waits for a start.
   *
   * Starting the same stage run again creates nothing new: the rows are unique per stage run and
   * source, and an instance id that already exists is skipped. The repeated start creates the
   * instances the first one did not get to, from the rows it stored.
   *
   * @throws TaskGroupInputError when the input or the settings are not what the group takes, which
   * fails the stage with the message
   */
  async startTaskGroupRun(request: TaskGroupStartRequest): Promise<void> {
    const { stageRunID, userUUID, settings, sources } = parseNewscastStart(request);
    const environment = this.env;
    const client = createNewscastSupabaseClient(environment);

    // A fresh random male+female voice pair PER newscast so the separate broadcasts sound distinct.
    // A row that already exists keeps the pair it was stored with.
    const rows = await insertNewscastsOfStageRun(
      client,
      stageRunID,
      sources.map((source, sourceIndex) =>
        insertOfSource(
          source,
          sourceIndex,
          stageRunID,
          userUUID,
          buildNewscastRequest(source, settings, pickRandomDialogueVoices()),
        ),
      ),
    );

    const { created, errors } = await environment.NEWSCAST_WORKFLOW.createBatch({
      instances: rows.map((row) => ({
        id: newscastInstanceID(stageRunID, row.source_index),
        params: {
          newscastID: row.id,
          userUUID: row.user_uuid,
          stageRunID,
          request: row.request,
        } as NewscastWorkflowParameters,
      })),
    });
    const failures = errors.filter((error) => error.code !== INSTANCE_ALREADY_EXISTS_CODE);
    if (failures.length > 0) {
      throw new Error(
        `Could not start ${failures.length} of ${rows.length} newscasts: ${failures.map((failure) => failure.message).join('; ')}`,
      );
    }
    logger.info('Newscast task group started', {
      stageRunID,
      newscasts: rows.length,
      created: created.length,
    }, { function: 'startTaskGroupRun' });

    // The first report; a failed one is only logged, because the instances already run and each
    // reports again when it finishes
    try {
      await reportStageRun(environment, client, stageRunID);
    } catch (error) {
      logger.warn('The first progress report failed', {
        stageRunID,
        error: error instanceof Error ? error.message : String(error),
      }, { function: 'startTaskGroupRun' });
    }
  }
}
