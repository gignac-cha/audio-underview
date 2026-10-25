/**
 * `POST /newscasts/schedulers { source }`: the scheduler of a newscast template (`template-definitions.ts`).
 *
 * The web screen asks for it before it starts a newscast and gets back the scheduler with the IDs of the two
 * stages it works with: the form the user answers and the newscast stage whose settings it saves.
 *
 * A user has one scheduler for each source, made the first time and used again after. The scheduler is made
 * through the public API of scheduler-manager-worker with the `Authorization` of the caller, so the scheduler
 * checks every stage as it would for the user. The only thing done here beside the user's own rights is the
 * subscription of the geeknews template, until the subscription API exists: the template gives the user the
 * `subscriber` permission on the system crawler `geeknews-list`, which the crawler stage needs.
 *
 * Errors:
 *   400 invalid_source        the body does not name one of the sources
 *   503 template_unavailable  the crawler of the geeknews template does not exist
 *   503 scheduler_unavailable the scheduler cannot be reached
 *   502 scheduler_rejected    the scheduler refused a request of the template
 *   502 scheduler_failed      the scheduler failed, or answered something unreadable
 */

import { createWorkerLogger } from '@audio-underview/logger';
import {
  createCrawlerPermission,
  getCrawlerPermission,
  getSystemCrawlerByName,
  type SupabaseClient,
} from '@audio-underview/supabase-connector';
import { errorResponse, jsonResponse, type ResponseContext } from '@audio-underview/worker-tools';
import type { Environment } from './environment.ts';
import {
  forgetNewscastScheduler,
  parseTemplateSource,
  readNewscastScheduler,
  rememberNewscastScheduler,
  type NewscastTemplateSource,
} from './newscast-schedulers.ts';
import {
  createSchedulerManagerClient,
  SchedulerManagerError,
  type SchedulerManagerClient,
} from './scheduler-manager-client.ts';
import {
  buildNewscastTemplate,
  GEEKNEWS_LIST_CRAWLER_NAME,
  NEWSCAST_TASK_GROUP_ID,
  type TemplateStageRole,
} from './template-definitions.ts';

const logger = createWorkerLogger({
  defaultContext: { module: 'newscast-worker-templates' },
});

/** A scheduler of a template, with the IDs of the stages the web screen works with. */
interface TemplateScheduler {
  schedulerID: string;
  formStageID: string;
  newscastStageID: string;
}

/** The template cannot be made because something it relies on is missing. */
class TemplateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateUnavailableError';
  }
}

/**
 * The scheduler the user remembered for a source, when it still exists and still has the two stages.
 * A scheduler that lost one of them cannot be used by the screen, so it counts as gone.
 */
async function findUsableScheduler(
  manager: SchedulerManagerClient,
  schedulerID: string,
): Promise<TemplateScheduler | null> {
  if (!(await manager.schedulerExists(schedulerID))) {
    return null;
  }
  const stages = await manager.listStages(schedulerID);
  const form = stages.find((stage) => stage.stage_type === 'form');
  const newscast = stages.find(
    (stage) => stage.stage_type === 'task_group' && stage.task_group_id === NEWSCAST_TASK_GROUP_ID,
  );
  if (form === undefined || newscast === undefined) {
    return null;
  }
  return { schedulerID, formStageID: form.id, newscastStageID: newscast.id };
}

/**
 * Subscribe the user to the system crawler `geeknews-list` unless they are already, and answer its ID.
 * The subscription API (TES-268) replaces this; until then the template is where the permission is made.
 */
async function subscribeToGeekNewsList(client: SupabaseClient, userUUID: string): Promise<string> {
  const crawler = await getSystemCrawlerByName(client, GEEKNEWS_LIST_CRAWLER_NAME);
  if (crawler === undefined) {
    throw new TemplateUnavailableError(`The system crawler '${GEEKNEWS_LIST_CRAWLER_NAME}' does not exist.`);
  }
  if ((await getCrawlerPermission(client, crawler.id, userUUID)) === undefined) {
    try {
      await createCrawlerPermission(client, { crawler_id: crawler.id, user_uuid: userUUID, level: 'subscriber' });
    } catch (error) {
      // Another request of the user made the permission between the read and the insert
      if ((await getCrawlerPermission(client, crawler.id, userUUID)) === undefined) {
        throw error;
      }
    }
  }
  return crawler.id;
}

/**
 * Make the scheduler of the template with its stages, in order. A scheduler that cannot get all its stages
 * is deleted again, so no half-made scheduler is left in the list of the user.
 */
async function createTemplateScheduler(
  manager: SchedulerManagerClient,
  source: NewscastTemplateSource,
  geeknewsListCrawlerID: string | undefined,
): Promise<TemplateScheduler> {
  const template = buildNewscastTemplate(source, geeknewsListCrawlerID);
  const schedulerID = await manager.createScheduler(template.name);
  try {
    const stageIDs = new Map<TemplateStageRole, string>();
    for (const [index, stage] of template.stages.entries()) {
      stageIDs.set(stage.role, await manager.createStage(schedulerID, { ...stage.request, stage_order: index }));
    }
    return { schedulerID, formStageID: stageIDs.get('form')!, newscastStageID: stageIDs.get('newscast')! };
  } catch (error) {
    await manager.deleteSchedulerQuietly(schedulerID);
    throw error;
  }
}

/**
 * The scheduler of the user for the source: the remembered one when it is still usable, else a new one that
 * is remembered in its place.
 *
 * A scheduler that could not be asked about (the scheduler is down) is never taken for a gone one: that
 * would make a second scheduler for a user who has one.
 */
async function ensureTemplateScheduler(
  client: SupabaseClient,
  manager: SchedulerManagerClient,
  userUUID: string,
  source: NewscastTemplateSource,
): Promise<TemplateScheduler> {
  const remembered = await readNewscastScheduler(client, userUUID, source);
  if (remembered !== null) {
    const usable = await findUsableScheduler(manager, remembered);
    if (usable !== null) {
      return usable;
    }
    await forgetNewscastScheduler(client, userUUID, source, remembered);
  }

  const geeknewsListCrawlerID = source === 'geeknews' ? await subscribeToGeekNewsList(client, userUUID) : undefined;
  const created = await createTemplateScheduler(manager, source, geeknewsListCrawlerID);
  try {
    const kept = await rememberNewscastScheduler(client, userUUID, source, created.schedulerID);
    if (kept !== created.schedulerID) {
      // Another request of the user made a scheduler for the source first; use that one and drop this one
      const usable = await findUsableScheduler(manager, kept);
      if (usable !== null) {
        await manager.deleteSchedulerQuietly(created.schedulerID);
        return usable;
      }
      // The other one cannot be used (it lost a stage), so this one stays, and the memory heals on the next request
    }
  } catch (error) {
    await manager.deleteSchedulerQuietly(created.schedulerID);
    throw error;
  }
  return created;
}

function schedulerFailureResponse(error: SchedulerManagerError, context: ResponseContext): Response {
  switch (error.kind) {
    case 'unreachable':
      return errorResponse('scheduler_unavailable', `${error.message} Try again in a moment.`, 503, context);
    case 'refused':
      return (error.status ?? 500) >= 500
        ? errorResponse('scheduler_failed', error.message, 502, context)
        : errorResponse('scheduler_rejected', error.message, 502, context);
    case 'unreadable':
      return errorResponse('scheduler_failed', error.message, 502, context);
  }
}

/**
 * POST /newscasts/schedulers — the scheduler of a template for the caller, made now or found.
 *
 * @param body - the parsed JSON body of the request, or `null` when it is not JSON
 * @param authorization - the `Authorization` header of the request, which the scheduler checks again
 */
export async function handleCreateNewscastScheduler(
  body: unknown,
  authorization: string,
  client: SupabaseClient,
  environment: Environment,
  userUUID: string,
  context: ResponseContext,
): Promise<Response> {
  const source = parseTemplateSource(
    body !== null && typeof body === 'object' ? (body as { source?: unknown }).source : undefined,
  );
  if (source === undefined) {
    return errorResponse('invalid_source', "source must be 'geeknews', 'url' or 'text'.", 400, context);
  }

  try {
    const scheduler = await ensureTemplateScheduler(
      client,
      createSchedulerManagerClient(environment, authorization),
      userUUID,
      source,
    );
    return jsonResponse(
      {
        scheduler_id: scheduler.schedulerID,
        form_stage_id: scheduler.formStageID,
        newscast_stage_id: scheduler.newscastStageID,
        source,
      },
      200,
      context,
    );
  } catch (error) {
    if (error instanceof SchedulerManagerError) {
      return schedulerFailureResponse(error, context);
    }
    if (error instanceof TemplateUnavailableError) {
      logger.error('A newscast template cannot be made', error, {
        function: 'handleCreateNewscastScheduler',
        metadata: { source },
      });
      return errorResponse('template_unavailable', error.message, 503, context);
    }
    throw error;
  }
}
