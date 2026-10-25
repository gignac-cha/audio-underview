import {
  type SupabaseClient,
  type SchedulerStageRow,
  type SchedulerStageRunRow,
  getSchedulerStageRun,
  getSchedulerStageRunByStage,
  createSchedulerStageRun,
  updateSchedulerStageRun,
} from '@audio-underview/supabase-connector';
import { DEFAULT_FORM_TIMEOUT_MINUTES, checkFormStageSettings } from './form-definition.ts';
import { resolveForm } from './form-resolution.ts';

/**
 * The steps of a form stage in a Workflow run: show the form (stage-<order>), wait for the answer
 * (stage-<order>-answered), then read the result from the stage run (stage-<order>-result).
 * The answer route stores the answer in the stage run and wakes the run (handlers/form-stage-runs.ts);
 * no step result carries it: the next stage reads it from the stage run.
 */

export interface FormStageContext {
  runID: string;
  /** The stage as load-stages read it */
  stage: SchedulerStageRow;
  /** Stage run of the previous stage, whose output is the input; null for the first stage */
  previousStageRunID: string | null;
}

export type FormStartResult =
  /** The stage run waits for its answer; wait at most this many minutes */
  | { status: 'waiting'; stageRunID: string; waitMinutes: number }
  /** A previous attempt of this step already left an ended stage run; read its result without waiting */
  | { status: 'settled'; stageRunID: string }
  | { status: 'failed'; error: string };

export type FormStageResult =
  | { status: 'completed'; stageRunID: string }
  | { status: 'failed'; error: string };

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Workflow event type that wakes the run waiting for the answer of one stage run.
 * Each stage run has its own type, so a repeated or late answer never wakes another stage.
 */
export function formAnsweredEventType(stageRunID: string): string {
  return `form-answered-${stageRunID}`;
}

/** How long a run waits for the answer of the stage: its timeout_minutes, or the default */
function formTimeoutMinutes(stage: SchedulerStageRow): number {
  const settingsCheck = checkFormStageSettings(stage.settings);
  return settingsCheck.valid ? settingsCheck.settings.timeoutMinutes : DEFAULT_FORM_TIMEOUT_MINUTES;
}

/**
 * What is left of the wait of a stage run a previous attempt of the start step created, at least
 * a minute; the whole timeout when the stage run does not say when it expires.
 */
function remainingWaitMinutes(stageRun: SchedulerStageRunRow, timeoutMinutes: number): number {
  const expiresAt = Date.parse(stageRun.form?.expires_at ?? '');
  if (!Number.isFinite(expiresAt)) return timeoutMinutes;
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / MILLISECONDS_PER_MINUTE));
}

/**
 * The stage-<order> step of a form stage: resolves the form from the input and records the stage
 * run waiting for its answer. A repeated attempt reuses the stage run it finds. A form that cannot
 * be shown is returned as a failure, like a crawler stage step.
 *
 * @throws when the database cannot be reached, so the step is retried
 */
export async function startFormStage(supabaseClient: SupabaseClient, context: FormStageContext): Promise<FormStartResult> {
  const { runID, stage, previousStageRunID } = context;

  // Workflows may run a step again that did not finish
  const existingStageRun = await getSchedulerStageRunByStage(supabaseClient, runID, stage.id);
  if (existingStageRun !== undefined) {
    if (existingStageRun.status === 'waiting') {
      return {
        status: 'waiting',
        stageRunID: existingStageRun.id,
        waitMinutes: remainingWaitMinutes(existingStageRun, formTimeoutMinutes(stage)),
      };
    }
    return { status: 'settled', stageRunID: existingStageRun.id };
  }

  let input: unknown;
  if (previousStageRunID === null) {
    input = {};
  } else {
    const previousStageRun = await getSchedulerStageRun(supabaseClient, previousStageRunID, runID);
    if (previousStageRun === undefined) {
      return { status: 'failed', error: `Stage ${stage.stage_order}: previous stage output not found` };
    }
    input = previousStageRun.output;
  }

  const startedAt = new Date();
  const stageRunValues = {
    run_id: runID,
    stage_id: stage.id,
    stage_order: stage.stage_order,
    input,
    started_at: startedAt.toISOString(),
  };

  // A form that cannot be shown is recorded as failed from the start
  const recordFailure = async (error: string): Promise<FormStartResult> => {
    await createSchedulerStageRun(supabaseClient, {
      ...stageRunValues,
      status: 'failed',
      completed_at: new Date().toISOString(),
      error,
    });
    return { status: 'failed', error };
  };

  // Checked when the stage was saved; checked again for a stage saved otherwise
  const settingsCheck = checkFormStageSettings(stage.settings);
  if (!settingsCheck.valid) {
    return await recordFailure(`Stage ${stage.stage_order}: form definition is not valid: ${settingsCheck.description}`);
  }
  const { form: definition, timeoutMinutes } = settingsCheck.settings;

  const resolution = resolveForm(definition, input);
  if (!resolution.resolved) {
    return await recordFailure(`Stage ${stage.stage_order}: no choices for '${resolution.fieldName}'`);
  }

  const stageRun = await createSchedulerStageRun(supabaseClient, {
    ...stageRunValues,
    status: 'waiting',
    form: {
      schema: resolution.form.schema,
      fields: resolution.form.fields,
      expires_at: new Date(startedAt.getTime() + timeoutMinutes * MILLISECONDS_PER_MINUTE).toISOString(),
    },
  });
  return { status: 'waiting', stageRunID: stageRun.id, waitMinutes: timeoutMinutes };
}

/**
 * The stage-<order>-result step: decides the stage's result from its stage run. A stage run still
 * waiting got no answer in time and is failed; one the owner cancelled is failed already.
 *
 * @throws when the database cannot be reached, so the step is retried
 */
export async function settleFormStage(
  supabaseClient: SupabaseClient,
  runID: string,
  stage: SchedulerStageRow,
  stageRunID: string,
): Promise<FormStageResult> {
  const stageOrder = stage.stage_order;
  let stageRun = await getSchedulerStageRun(supabaseClient, stageRunID, runID);

  if (stageRun?.status === 'waiting') {
    const failedStageRun = await updateSchedulerStageRun(supabaseClient, stageRunID, runID, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      error: `Stage ${stageOrder}: no answer within ${formTimeoutMinutes(stage)} minutes`,
    }, { onlyIfStatus: ['waiting'] });
    // Not changed: the answer or a cancel arrived in the meantime
    stageRun = failedStageRun ?? await getSchedulerStageRun(supabaseClient, stageRunID, runID);
  }

  // The stage or the scheduler was deleted
  if (stageRun === undefined) {
    return { status: 'failed', error: `Stage ${stageOrder}: stage run record was removed` };
  }

  if (stageRun.status === 'completed') {
    return { status: 'completed', stageRunID };
  }
  return { status: 'failed', error: stageRun.error ?? `Stage ${stageOrder}: form failed` };
}
