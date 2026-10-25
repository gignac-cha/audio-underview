import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  fetchSchedulerManager,
  parseResponseJSON,
  requestSchedulerManagerJSON,
  throwResponseError,
} from './scheduler-manager-request.ts';
import { requestNewscastWorkerJSON } from './newscast-request.ts';
import { NEWSCASTS_QUERY_KEY } from './use-newscast-jobs.ts';
import {
  formStageRunSchema,
  isRunInProgress,
  newscastTemplateSchema,
  schedulerRunListSchema,
  schedulerRunSchema,
  type NewscastSource,
  type NewscastTemplate,
  type SchedulerRun,
  type StageRunForm,
} from '../schemas/newscast-schedulers.ts';

/**
 * Starts a newscast through the template scheduler of its source, the way the New newscast panel
 * does it:
 *
 * 1. `POST /newscasts/schedulers { source }` (newscast worker) answers the scheduler, its form
 *    stage and its newscast stage
 * 2. `PUT /schedulers/:id/stages/:stageID { settings }` stores the settings on the newscast stage
 * 3. `POST /schedulers/:id/execute` starts a run (202), or answers 409 while a run is in progress
 * 4. the run is read until its form stage run waits, and the stage run is read for its `form`
 * 5. the form is answered: a URL or a text with what was typed before the start, GeekNews with
 *    the articles picked from the form's choices
 *
 * After the answer the run makes the newscasts, and it is read until it ends so that the page keeps
 * the list fresh and a run that fails before any newscast exists still says why.
 *
 * An answer or a cancel that finds the form no longer waiting (it expired, or it was answered or
 * cancelled elsewhere) goes back to idle with a notice, so the newscast can be started again.
 */

/** How often the run is read while its form opens and while it makes the newscasts. */
export const RUN_POLL_INTERVAL_MILLISECONDS = 2000;

export interface NewNewscastStart {
  source: NewscastSource;
  /** The settings of the newscast group stage */
  settings: Record<string, unknown>;
  /**
   * The answer of a form that is typed before the start (URL, Text). A GeekNews form is answered
   * with {@link NewNewscast.answerChoices} once its choices are known.
   */
  answer?: Record<string, unknown>;
}

interface StartedRun {
  schedulerID: string;
  runID: string;
  formStageID: string;
}

/** A form stage run that waits for an answer. */
export interface WaitingForm {
  schedulerID: string;
  runID: string;
  stageRunID: string;
}

export interface OpenForm extends WaitingForm {
  form: StageRunForm;
}

export type NewNewscastStep =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'waiting-for-form' }
  | { kind: 'answering' }
  | { kind: 'choosing'; openForm: OpenForm; isAnswering: boolean }
  | { kind: 'making' }
  // A run of the scheduler was already in progress; it may wait for an answer
  | { kind: 'busy'; waitingForm?: WaitingForm; isCancelling: boolean };

function unreadableResponseError() {
  return new Error('The server sent a response this page cannot read.');
}

/**
 * The form stopped waiting before the answer or the cancel reached it (409 not_waiting): it expired,
 * or it was answered or cancelled elsewhere. There is nothing left to answer or cancel.
 */
class FormNotWaitingError extends Error {
  constructor() {
    super('This newscast is no longer waiting for an answer: its form expired or was closed elsewhere. Start it again.');
    this.name = 'FormNotWaitingError';
  }
}

function parseWith<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw unreadableResponseError();
  }
  return result.data;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function createTemplate(source: NewscastSource): Promise<NewscastTemplate> {
  const body = await requestNewscastWorkerJSON('/newscasts/schedulers', { method: 'POST', body: { source } });
  return parseWith(newscastTemplateSchema, body);
}

async function saveSettings(template: NewscastTemplate, settings: Record<string, unknown>): Promise<void> {
  await requestSchedulerManagerJSON(`/schedulers/${template.scheduler_id}/stages/${template.newscast_stage_id}`, {
    method: 'PUT',
    body: { settings },
  });
}

/**
 * The run that the manual run started, or undefined when a run of the scheduler is already in
 * progress (409). A body with a run_id that is not 2xx is a run that failed at once.
 */
async function executeScheduler(schedulerID: string): Promise<string | undefined> {
  const response = await fetchSchedulerManager(`/schedulers/${schedulerID}/execute`, { method: 'POST' });
  if (response.status === 409) {
    return undefined;
  }
  const body = await parseResponseJSON(response);
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    if (typeof record.run_id === 'string' && typeof record.error === 'string') {
      throw new Error(record.error);
    }
    throwResponseError(body, response.status);
  }
  if (typeof record.run_id !== 'string') {
    throw unreadableResponseError();
  }
  return record.run_id;
}

async function readRun(schedulerID: string, runID: string): Promise<SchedulerRun> {
  return parseWith(schedulerRunSchema, await requestSchedulerManagerJSON(`/schedulers/${schedulerID}/runs/${runID}`));
}

function stageRunPath(form: WaitingForm): string {
  return `/schedulers/${form.schedulerID}/runs/${form.runID}/stage-runs/${form.stageRunID}`;
}

/** Reads the run until its form stage run waits, then the form of that stage run. */
async function waitForForm(run: StartedRun, intervalMilliseconds: number, signal: AbortSignal): Promise<OpenForm> {
  for (;;) {
    const detail = await readRun(run.schedulerID, run.runID);
    signal.throwIfAborted();
    const formStageRun = detail.stage_runs.find((stageRun) => stageRun.stage_id === run.formStageID);
    if (formStageRun?.status === 'waiting') {
      const waitingForm = { schedulerID: run.schedulerID, runID: run.runID, stageRunID: formStageRun.id };
      const stageRun = parseWith(formStageRunSchema, await requestSchedulerManagerJSON(stageRunPath(waitingForm)));
      signal.throwIfAborted();
      if (stageRun.status === 'waiting' && stageRun.form) {
        return { ...waitingForm, form: stageRun.form };
      }
    } else if (formStageRun !== undefined && !isRunInProgress(formStageRun.status)) {
      throw new Error(formStageRun.error ?? 'The form closed before it was answered.');
    }
    if (!isRunInProgress(detail.status)) {
      throw new Error(detail.error ?? 'The run ended before its form opened.');
    }
    await delay(intervalMilliseconds, signal);
  }
}

/** The form that the run in progress waits on, if it waits on one. */
async function findWaitingForm(schedulerID: string): Promise<WaitingForm | undefined> {
  const searchParameters = new URLSearchParams({ offset: '0', limit: '5' });
  const runs = parseWith(
    schedulerRunListSchema,
    await requestSchedulerManagerJSON(`/schedulers/${schedulerID}/runs?${searchParameters.toString()}`),
  );
  const runInProgress = runs.data.find((run) => isRunInProgress(run.status));
  if (runInProgress === undefined) {
    return undefined;
  }
  const detail = await readRun(schedulerID, runInProgress.id);
  const waitingStageRun = detail.stage_runs.find((stageRun) => stageRun.status === 'waiting');
  return waitingStageRun === undefined
    ? undefined
    : { schedulerID, runID: runInProgress.id, stageRunID: waitingStageRun.id };
}

/** Answers or cancels a waiting form; a form that no longer waits throws {@link FormNotWaitingError}. */
async function postToForm(form: WaitingForm, action: 'answer' | 'cancel', body?: unknown): Promise<void> {
  const response = await fetchSchedulerManager(`${stageRunPath(form)}/${action}`, { method: 'POST', body });
  const responseBody = await parseResponseJSON(response);
  if (!response.ok) {
    const record = (typeof responseBody === 'object' && responseBody !== null ? responseBody : {}) as Record<string, unknown>;
    if (response.status === 409 && record.error === 'not_waiting') {
      throw new FormNotWaitingError();
    }
    throwResponseError(responseBody, response.status);
  }
}

async function answerForm(form: WaitingForm, answer: Record<string, unknown>): Promise<void> {
  await postToForm(form, 'answer', { answer });
}

async function cancelForm(form: WaitingForm): Promise<void> {
  await postToForm(form, 'cancel');
}

interface NewNewscastOptions {
  pollIntervalMilliseconds?: number;
}

export interface NewNewscast {
  step: NewNewscastStep;
  /** Why the last start, answer or cancel did not go through */
  error: string | undefined;
  start: (input: NewNewscastStart) => Promise<void>;
  /** Answers the open GeekNews form with the indices of the picked choices. */
  answerChoices: (indices: number[]) => Promise<void>;
  /** Cancels the form that waits, the open one or the one of the run in progress. */
  cancel: () => Promise<boolean>;
  /** Goes back to idle, leaving a run in progress as it is. */
  dismiss: () => void;
}

export function useNewNewscast(options: NewNewscastOptions = {}): NewNewscast {
  const intervalMilliseconds = options.pollIntervalMilliseconds ?? RUN_POLL_INTERVAL_MILLISECONDS;
  const queryClient = useQueryClient();
  const [step, setStep] = useState<NewNewscastStep>({ kind: 'idle' });
  const [error, setError] = useState<string>();
  // One flow at a time: a new start, a cancel or leaving the page stops the reads of the last one
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const beginFlow = (): AbortSignal => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  };

  const refreshList = () => {
    queryClient.invalidateQueries({ queryKey: NEWSCASTS_QUERY_KEY, exact: true });
  };

  /** Reads the run until it ends, while it makes the newscasts. */
  const followRun = async (run: { schedulerID: string; runID: string }, signal: AbortSignal) => {
    setStep({ kind: 'making' });
    refreshList();
    for (;;) {
      await delay(intervalMilliseconds, signal);
      const detail = await readRun(run.schedulerID, run.runID);
      signal.throwIfAborted();
      if (!isRunInProgress(detail.status)) {
        refreshList();
        if (detail.status !== 'completed') {
          setError(detail.error ?? `The run ended as ${detail.status}.`);
        }
        setStep({ kind: 'idle' });
        return;
      }
    }
  };

  const fail = (signal: AbortSignal, caught: unknown, next: NewNewscastStep) => {
    if (signal.aborted) {
      return;
    }
    setError(caught instanceof Error ? caught.message : String(caught));
    setStep(next);
  };

  const start = async (input: NewNewscastStart) => {
    const signal = beginFlow();
    setError(undefined);
    setStep({ kind: 'starting' });
    try {
      const template = await createTemplate(input.source);
      signal.throwIfAborted();
      await saveSettings(template, input.settings);
      signal.throwIfAborted();
      const runID = await executeScheduler(template.scheduler_id);
      signal.throwIfAborted();
      if (runID === undefined) {
        // The notice does not depend on finding the form: without one there is just nothing to cancel
        const waitingForm = await findWaitingForm(template.scheduler_id).catch(() => undefined);
        signal.throwIfAborted();
        setStep({ kind: 'busy', waitingForm, isCancelling: false });
        return;
      }

      const run: StartedRun = { schedulerID: template.scheduler_id, runID, formStageID: template.form_stage_id };
      setStep({ kind: 'waiting-for-form' });
      const openForm = await waitForForm(run, intervalMilliseconds, signal);

      if (input.answer === undefined) {
        setStep({ kind: 'choosing', openForm, isAnswering: false });
        return;
      }
      setStep({ kind: 'answering' });
      try {
        await answerForm(openForm, input.answer);
      } catch (answerError) {
        // Unless it stopped waiting, the form still waits, so the run can be cancelled from the notice
        fail(
          signal,
          answerError,
          answerError instanceof FormNotWaitingError
            ? { kind: 'idle' }
            : { kind: 'busy', waitingForm: openForm, isCancelling: false },
        );
        return;
      }
      signal.throwIfAborted();
      await followRun(run, signal);
    } catch (caught) {
      fail(signal, caught, { kind: 'idle' });
    }
  };

  const answerChoices = async (indices: number[]) => {
    if (step.kind !== 'choosing') {
      return;
    }
    const { openForm } = step;
    const signal = beginFlow();
    setError(undefined);
    setStep({ kind: 'choosing', openForm, isAnswering: true });
    const field = openForm.form.fields[0];
    try {
      await answerForm(openForm, { [field?.name ?? 'articles']: indices });
    } catch (answerError) {
      // A form that stopped waiting cannot be answered any more, so the pick is closed
      fail(
        signal,
        answerError,
        answerError instanceof FormNotWaitingError ? { kind: 'idle' } : { kind: 'choosing', openForm, isAnswering: false },
      );
      return;
    }
    try {
      await followRun(openForm, signal);
    } catch (caught) {
      fail(signal, caught, { kind: 'idle' });
    }
  };

  const cancel = async (): Promise<boolean> => {
    const waitingForm =
      step.kind === 'choosing' ? step.openForm : step.kind === 'busy' ? step.waitingForm : undefined;
    if (waitingForm === undefined) {
      return false;
    }
    const restore = step;
    const signal = beginFlow();
    setError(undefined);
    setStep(step.kind === 'choosing' ? { ...step, isAnswering: true } : { kind: 'busy', waitingForm, isCancelling: true });
    try {
      await cancelForm(waitingForm);
    } catch (cancelError) {
      // A form that stopped waiting has nothing left to cancel, so its pick or notice is closed
      fail(signal, cancelError, cancelError instanceof FormNotWaitingError ? { kind: 'idle' } : restore);
      return false;
    }
    if (!signal.aborted) {
      setStep({ kind: 'idle' });
    }
    return true;
  };

  const dismiss = () => {
    controllerRef.current?.abort();
    setError(undefined);
    setStep({ kind: 'idle' });
  };

  return { step, error, start, answerChoices, cancel, dismiss };
}
