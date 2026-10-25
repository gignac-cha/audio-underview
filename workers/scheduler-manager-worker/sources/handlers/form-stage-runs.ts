import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  type SupabaseClient,
  type SchedulerRunRow,
  type SchedulerStageRunForm,
  type SchedulerStageRunRow,
  createSupabaseClient,
  getSchedulerRun,
  getSchedulerStage,
  getSchedulerStageRun,
  updateSchedulerStageRun,
} from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from '../index.ts';
import { checkFormStageSettings } from '../form-definition.ts';
import { findRepeatedChoice, mapAnswer } from '../form-resolution.ts';
import { formAnsweredEventType } from '../form-stage.ts';
import { runInstanceID } from '../schedule.ts';
import { UnsupportedSchemaError, validateAgainstSchema } from '../schema-validation.ts';
import { verifySchedulerOwnership } from './tools.ts';

/**
 * The owner's answer to a form stage run that waits for it, or the owner's cancel of it. Either ends
 * the stage run, only while it still waits, then wakes the run waiting for it in its Workflow
 * instance (form-stage.ts), which reads the stage run.
 */

interface AnswerRequestBody {
  answer?: unknown;
}

interface WaitingFormStageRun {
  run: SchedulerRunRow;
  stageRun: SchedulerStageRunRow & { form: SchedulerStageRunForm };
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'form-stage-runs-handler',
  },
});

// How many times waking a run is tried, and the wait before the second try, doubled before each next one
const WAKE_ATTEMPTS = 3;
const WAKE_RETRY_DELAY_MILLISECONDS = 100;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notWaitingResponse(context: ResponseContext): Response {
  return errorResponse('not_waiting', 'This stage is not waiting for an answer', 409, context);
}

function invalidAnswerResponse(context: ResponseContext, path: string, reason: string): Response {
  return jsonResponse({
    error: 'invalid_answer',
    error_description: `The answer does not match the form: ${path} ${reason}`,
    path,
    reason,
  }, 400, context);
}

/**
 * Reads the run and the stage run a request names. The run must be one of the scheduler, whose
 * ownership the caller checked, and the stage run one of the run.
 *
 * @returns an error response, or the run and its form stage run that waits for an answer
 */
async function readWaitingFormStageRun(
  supabaseClient: SupabaseClient,
  context: ResponseContext,
  schedulerID: string,
  runID: string,
  stageRunID: string,
): Promise<Response | WaitingFormStageRun> {
  const run = await getSchedulerRun(supabaseClient, runID, schedulerID);
  if (!run) {
    return errorResponse('not_found', 'Run not found', 404, context);
  }

  const stageRun = await getSchedulerStageRun(supabaseClient, stageRunID, runID);
  if (!stageRun) {
    return errorResponse('not_found', 'Stage run not found', 404, context);
  }

  // Only a form stage run waits, and it shows its form while it does
  if (stageRun.status !== 'waiting' || !isPlainObject(stageRun.form)) {
    return notWaitingResponse(context);
  }
  return { run, stageRun: stageRun as WaitingFormStageRun['stageRun'] };
}

/**
 * Wakes the Workflow instance waiting for the stage run, trying again a few times, since a run that
 * is not woken waits until its timeout. The event may arrive before the instance waits for it;
 * Workflows keeps it until then, and a second event of a try that only seemed to fail does no harm,
 * as the instance waits for the event once. The stage run has ended already, so an instance that
 * cannot be woken still reads how it ended when its wait runs out: the failure is logged, and the
 * request still succeeds.
 */
async function wakeRun(environment: Environment, run: SchedulerRunRow, stageRunID: string): Promise<void> {
  const metadata = { schedulerID: run.scheduler_id, runID: run.id, stageRunID };
  let lastError: unknown;
  for (let attempt = 1; attempt <= WAKE_ATTEMPTS; attempt++) {
    try {
      const instance = await environment.SCHEDULER_RUN_WORKFLOW.get(runInstanceID(run));
      await instance.sendEvent({
        type: formAnsweredEventType(stageRunID),
        payload: { stageRunID },
      });
      return;
    } catch (error: unknown) {
      lastError = error;
      if (attempt < WAKE_ATTEMPTS) {
        logger.warn('Run waiting for a form could not be woken, trying again', error, {
          function: 'wakeRun',
          metadata: { ...metadata, attempt },
        });
        await sleep(WAKE_RETRY_DELAY_MILLISECONDS * 2 ** (attempt - 1));
      }
    }
  }
  logger.error('Run waiting for a form could not be woken; it reads the stage run when its wait runs out', lastError, {
    function: 'wakeRun',
    metadata: { ...metadata, attempts: WAKE_ATTEMPTS },
  });
}

/**
 * POST /schedulers/:id/runs/:runID/stage-runs/:stageRunID/answer { answer }
 *
 * Checks the answer against the form the stage run shows, stores the values its choices stand for
 * as the output of the stage run, and completes it.
 */
export async function handleAnswerFormStageRun(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  runID: string,
  stageRunID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  let body: AnswerRequestBody;
  try {
    body = await request.json() as AnswerRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (!isPlainObject(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  const { answer } = body;
  if (!isPlainObject(answer)) {
    return errorResponse('invalid_request', "Field 'answer' is required and must be a JSON object", 400, context);
  }

  const waiting = await readWaitingFormStageRun(supabaseClient, context, schedulerID, runID, stageRunID);
  if (waiting instanceof Response) return waiting;
  const { run, stageRun } = waiting;

  let validation;
  try {
    validation = validateAgainstSchema(stageRun.form.schema, answer);
  } catch (error: unknown) {
    if (!(error instanceof UnsupportedSchemaError)) throw error;
    // The scheduler wrote the form, so this is a problem of the scheduler, not of the request
    logger.error('Form of a stage run cannot be read', error, {
      function: 'handleAnswerFormStageRun',
      metadata: { schedulerID, runID, stageRunID },
    });
    return errorResponse('server_error', 'Form format cannot be read', 500, context);
  }
  if (!validation.valid) {
    return invalidAnswerResponse(context, validation.path, validation.message);
  }

  const repeatedChoice = findRepeatedChoice(stageRun.form, answer);
  if (repeatedChoice !== undefined) {
    return invalidAnswerResponse(context, repeatedChoice.path, repeatedChoice.reason);
  }

  // The numbers stand for the choices the definition of the stage resolves from the input of the stage run
  const stage = await getSchedulerStage(supabaseClient, stageRun.stage_id, schedulerID);
  const settingsCheck = stage?.stage_type === 'form' ? checkFormStageSettings(stage.settings) : undefined;
  const mapping = settingsCheck?.valid === true
    ? mapAnswer(settingsCheck.settings.form, stageRun.form, stageRun.input, answer)
    : { mapped: false as const };
  if (!mapping.mapped) {
    return errorResponse(
      'form_changed',
      'The form of this stage changed after the run reached it; cancel the run and run it again',
      409,
      context,
    );
  }

  const completedStageRun = await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    output: mapping.output,
  }, { onlyIfStatus: ['waiting'] });
  // Answered, cancelled or timed out in the meantime
  if (completedStageRun === undefined) {
    return notWaitingResponse(context);
  }

  await wakeRun(environment, run, stageRun.id);
  return jsonResponse({ status: 'completed' }, 200, context);
}

/**
 * POST /schedulers/:id/runs/:runID/stage-runs/:stageRunID/cancel
 *
 * Fails the form stage run, which fails its run.
 */
export async function handleCancelFormStageRun(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  runID: string,
  stageRunID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  const waiting = await readWaitingFormStageRun(supabaseClient, context, schedulerID, runID, stageRunID);
  if (waiting instanceof Response) return waiting;
  const { run, stageRun } = waiting;

  const failedStageRun = await updateSchedulerStageRun(supabaseClient, stageRun.id, runID, {
    status: 'failed',
    completed_at: new Date().toISOString(),
    error: `Stage ${stageRun.stage_order}: cancelled by the owner`,
  }, { onlyIfStatus: ['waiting'] });
  // Answered, cancelled or timed out in the meantime
  if (failedStageRun === undefined) {
    return notWaitingResponse(context);
  }

  await wakeRun(environment, run, stageRun.id);
  return jsonResponse({ status: 'failed' }, 200, context);
}
