import { useEffect, useRef } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SchedulerFormChoice,
  SchedulerFormField,
  SchedulerFormWidget,
  SchedulerRunRow,
  SchedulerRunStatus,
  SchedulerStageRunForm,
  SchedulerStageRunRow,
} from '@audio-underview/supabase-connector';
import {
  DEFAULT_PAGE_LIMIT,
  RUN_TIMEOUT_MILLISECONDS,
  fetchSchedulerManager,
  hasAccessToken,
  parseResponseJSON,
  requestSchedulerManagerJSON,
  throwResponseError,
  type PaginatedParameters,
  type PaginatedResponse,
} from './scheduler-manager-request.ts';
import { SCHEDULERS_QUERY_KEY, schedulerDetailKey } from './use-scheduler-manager.ts';

// ─── Types ─────────────────────────────────────────────────────

type WithoutIndexSignature<T> = {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};

/**
 * A stage run without its input, output, form and logs, which can be large. The connector's
 * SchedulerStageRunSummary is Omit<> of a row type with an index signature, which drops the named
 * fields, so it is built here from the named fields only.
 */
export type StageRunSummary = Omit<WithoutIndexSignature<SchedulerStageRunRow>, 'input' | 'output' | 'form' | 'logs'>;

/** A run with the summaries of its stage runs */
export type SchedulerRunDetail = SchedulerRunRow & { stage_runs: StageRunSummary[] };

/** What the manual run answers once the run is recorded */
export interface SchedulerExecution {
  run_id: string;
  status: SchedulerRunStatus;
  error: string | null;
}

/** What the answer and cancel requests answer: the status the stage run has now */
export interface StageRunActionResult {
  status: SchedulerRunStatus;
}

interface StageRunActionInput {
  scheduler_id: string;
  run_id: string;
  stage_run_id: string;
}

interface AnswerStageRunInput extends StageRunActionInput {
  // The value of each field by its name; a choice is named by its index
  answer: Record<string, unknown>;
}

interface RefreshOptions {
  // How often a run that is pending or running is read again
  refreshIntervalMilliseconds?: number;
}

export const RUN_REFRESH_INTERVAL_MILLISECONDS = 5_000;

export const RUN_IN_PROGRESS_MESSAGE = 'A run is already in progress';

const RUN_STATUSES: readonly SchedulerRunStatus[] = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'partially_failed',
  'skipped',
];

// A form stage run waits for an answer while its run goes on, so it is not finished
export function isInProgress(status: SchedulerRunStatus | undefined): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting';
}

// ─── Query keys ────────────────────────────────────────────────

export function schedulerRunsKey(schedulerID: string) {
  return ['schedulers', schedulerID, 'runs'] as const;
}

function runDetailKey(schedulerID: string, runID: string) {
  return [...schedulerRunsKey(schedulerID), runID] as const;
}

function stageRunKey(schedulerID: string, runID: string, stageRunID: string, isFinished: boolean) {
  return [...runDetailKey(schedulerID, runID), 'stage-runs', stageRunID, isFinished ? 'finished' : 'in-progress'] as const;
}

// ─── Run hooks ────────────────────────────────────────────────

/**
 * Reads the scheduler and the schedulers list again once the run history shows that a run that was
 * in progress has ended. The server records the last run time of the scheduler when it ends the
 * run, which for a run that a Workflow runs is after the manual run has answered 202.
 */
function useRefreshSchedulerWhenRunEnds(schedulerID: string | undefined, isRunInProgress: boolean) {
  const queryClient = useQueryClient();
  const previous = useRef({ schedulerID, isRunInProgress: false });

  useEffect(() => {
    const wasRunInProgress = previous.current.schedulerID === schedulerID && previous.current.isRunInProgress;
    previous.current = { schedulerID, isRunInProgress };
    if (schedulerID && wasRunInProgress && !isRunInProgress) {
      queryClient.invalidateQueries({ queryKey: schedulerDetailKey(schedulerID), exact: true });
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY, exact: true });
    }
  }, [queryClient, schedulerID, isRunInProgress]);
}

export function useListRuns(schedulerID: string | undefined, options: RefreshOptions = {}) {
  const refreshIntervalMilliseconds = options.refreshIntervalMilliseconds ?? RUN_REFRESH_INTERVAL_MILLISECONDS;

  const query = useInfiniteQuery<
    PaginatedResponse<SchedulerRunRow>,
    Error,
    { pages: PaginatedResponse<SchedulerRunRow>[] },
    readonly string[],
    PaginatedParameters
  >({
    queryKey: schedulerRunsKey(schedulerID ?? ''),
    queryFn: async ({ pageParam }) => {
      const searchParameters = new URLSearchParams({
        offset: String(pageParam.offset),
        limit: String(pageParam.limit),
      });
      return await requestSchedulerManagerJSON(
        `/schedulers/${schedulerID}/runs?${searchParameters.toString()}`,
      ) as PaginatedResponse<SchedulerRunRow>;
    },
    initialPageParam: { offset: 0, limit: DEFAULT_PAGE_LIMIT },
    getNextPageParam: (lastPage) => {
      if (lastPage.offset + lastPage.limit < lastPage.total) {
        return { offset: lastPage.offset + lastPage.limit, limit: lastPage.limit };
      }
      return undefined;
    },
    enabled: hasAccessToken() && !!schedulerID,
    // Stops by itself once no run is pending or running
    refetchInterval: (listQuery) => {
      const pages = listQuery.state.data?.pages ?? [];
      return pages.some((page) => page.data.some((run) => isInProgress(run.status)))
        ? refreshIntervalMilliseconds
        : false;
    },
  });

  const runs = query.data?.pages.flatMap((page) => page.data) ?? [];
  useRefreshSchedulerWhenRunEnds(schedulerID, runs.some((run) => isInProgress(run.status)));

  // A failed refresh keeps the earlier answer, so the runs stay and the error is only a notice
  const hasLoaded = query.data !== undefined;
  const error = query.error ?? undefined;

  return {
    runs,
    isLoading: query.isLoading,
    // The error of a list that was never read, which leaves nothing to show
    error: hasLoaded ? undefined : error,
    // The error of a refresh of a list that was read, which clears with the next refresh that works
    refreshError: hasLoaded ? error : undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/**
 * One run with its stage runs. Read again every time the run is opened, whatever the staleness of
 * the answer in the cache, and while the run is pending or running.
 */
export function useGetRun(schedulerID: string | undefined, runID: string | undefined, options: RefreshOptions = {}) {
  const refreshIntervalMilliseconds = options.refreshIntervalMilliseconds ?? RUN_REFRESH_INTERVAL_MILLISECONDS;

  const query = useQuery<SchedulerRunDetail, Error>({
    queryKey: runDetailKey(schedulerID ?? '', runID ?? ''),
    queryFn: async () => {
      return await requestSchedulerManagerJSON(`/schedulers/${schedulerID}/runs/${runID}`) as SchedulerRunDetail;
    },
    enabled: hasAccessToken() && !!schedulerID && !!runID,
    refetchOnMount: 'always',
    refetchInterval: (runQuery) => (isInProgress(runQuery.state.data?.status) ? refreshIntervalMilliseconds : false),
  });

  // An answer already in the cache when the run is opened is the one of an earlier opening
  const updatedAtWhenOpened = useRef(query.dataUpdatedAt);

  return {
    run: query.data ?? undefined,
    isLoading: query.isLoading,
    // False while run is still the answer of an earlier opening, until the read that this opening starts arrives
    hasReadSinceOpened: query.dataUpdatedAt > updatedAtWhenOpened.current,
    error: query.error ?? undefined,
  };
}

/**
 * One stage run with its input, output and logs. isFinished is part of the query key, so the
 * stage run is read once more when its stage ends while the earlier answer stays on screen.
 */
export function useGetStageRun(
  schedulerID: string,
  runID: string,
  stageRunID: string,
  isFinished: boolean,
) {
  const query = useQuery<SchedulerStageRunRow, Error>({
    queryKey: stageRunKey(schedulerID, runID, stageRunID, isFinished),
    queryFn: async () => {
      return await requestSchedulerManagerJSON(
        `/schedulers/${schedulerID}/runs/${runID}/stage-runs/${stageRunID}`,
      ) as SchedulerStageRunRow;
    },
    enabled: hasAccessToken(),
    placeholderData: keepPreviousData,
  });

  // A failed read leaves no data in the query, not even the placeholder, so the last answer is held
  // here to stay on screen
  const heldStageRun = useRef<SchedulerStageRunRow | undefined>(undefined);
  if (query.data !== undefined) {
    heldStageRun.current = query.data;
  }
  const error = query.error ?? undefined;

  return {
    stageRun: heldStageRun.current,
    isLoading: query.isLoading,
    // The error of a stage run that was never read, which leaves nothing to show
    error: heldStageRun.current === undefined ? error : undefined,
    // The error of a read of a stage run that was read, which clears with the next read that works
    refreshError: heldStageRun.current === undefined ? undefined : error,
  };
}

const FORM_WIDGETS: readonly SchedulerFormWidget[] = [
  'checkboxes',
  'radio',
  'select',
  'text',
  'textarea',
  'number',
  'toggle',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readFormField(value: unknown): SchedulerFormField | undefined {
  if (!isPlainObject(value) || typeof value.name !== 'string') return undefined;
  const widget = FORM_WIDGETS.find((candidate) => candidate === value.widget);
  if (widget === undefined) return undefined;

  let choices: SchedulerFormChoice[] | undefined;
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) return undefined;
    choices = [];
    for (const choice of value.choices) {
      if (!isPlainObject(choice) || typeof choice.label !== 'string') return undefined;
      choices.push({ label: choice.label, description: readOptionalString(choice.description) });
    }
  }
  // A field that is asked by choice has them
  if ((widget === 'checkboxes' || widget === 'radio' || widget === 'select') && choices === undefined) return undefined;

  return {
    name: value.name,
    title: readOptionalString(value.title),
    description: readOptionalString(value.description),
    widget,
    required: value.required === true,
    choices,
    minItems: readOptionalNumber(value.minItems),
    maxItems: readOptionalNumber(value.maxItems),
    maxLength: readOptionalNumber(value.maxLength),
    minimum: readOptionalNumber(value.minimum),
    maximum: readOptionalNumber(value.maximum),
    default: value.default,
  };
}

/**
 * The form of a stage run as the server stores it, or undefined when the stage run has none or what
 * it has cannot be read, so a form this page cannot show is never half shown.
 */
export function readStageRunForm(value: unknown): SchedulerStageRunForm | undefined {
  if (!isPlainObject(value) || !Array.isArray(value.fields) || typeof value.expires_at !== 'string') return undefined;
  const fields: SchedulerFormField[] = [];
  for (const candidate of value.fields) {
    const field = readFormField(candidate);
    if (field === undefined) return undefined;
    fields.push(field);
  }
  return {
    schema: isPlainObject(value.schema) ? value.schema : {},
    fields,
    expires_at: value.expires_at,
  };
}

function readRunStatus(value: unknown, fallback: SchedulerRunStatus): SchedulerRunStatus {
  return RUN_STATUSES.find((status) => status === value) ?? fallback;
}

/**
 * A body with a run_id means the run was recorded, whatever the status code: a run that failed
 * answers 408, 422 or 500 with its run_id. 202 means a Workflow runs it.
 */
async function executeSchedulerRequest(schedulerID: string): Promise<SchedulerExecution> {
  const response = await fetchSchedulerManager(`/schedulers/${schedulerID}/execute`, {
    method: 'POST',
    timeoutMilliseconds: RUN_TIMEOUT_MILLISECONDS,
  });
  const body = await parseResponseJSON(response);

  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof record.run_id === 'string') {
    return {
      run_id: record.run_id,
      status: readRunStatus(record.status, response.ok ? 'completed' : 'failed'),
      error: typeof record.error === 'string' ? record.error : null,
    };
  }
  if (response.status === 409) {
    throw new Error(RUN_IN_PROGRESS_MESSAGE);
  }
  if (!response.ok) {
    throwResponseError(body, response.status);
  }
  throw new Error('The server sent a response this page cannot read.');
}

export function useExecuteScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerExecution, Error, string>({
    mutationFn: executeSchedulerRequest,
    // Settled, not succeeded: a run that timed out on the way back may still have been recorded
    onSettled: (_data, _error, schedulerID) => {
      queryClient.invalidateQueries({ queryKey: schedulerRunsKey(schedulerID) });
      queryClient.invalidateQueries({ queryKey: schedulerDetailKey(schedulerID), exact: true });
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY, exact: true });
    },
  });

  return {
    executeScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

function stageRunActionPath({ scheduler_id, run_id, stage_run_id }: StageRunActionInput, action: 'answer' | 'cancel') {
  return `/schedulers/${scheduler_id}/runs/${run_id}/stage-runs/${stage_run_id}/${action}`;
}

/**
 * Answers the form a stage run waits for. The server answers 409 when the stage run is not waiting
 * (it was answered, cancelled or timed out) and 400 with the reason when the answer is refused; both
 * throw the server's own text.
 */
export function useAnswerStageRun() {
  const queryClient = useQueryClient();

  const mutation = useMutation<StageRunActionResult, Error, AnswerStageRunInput>({
    mutationFn: async ({ answer, ...input }) => {
      return await requestSchedulerManagerJSON(stageRunActionPath(input, 'answer'), {
        method: 'POST',
        body: { answer },
      }) as StageRunActionResult;
    },
    // Settled, not succeeded: a refused answer may mean the stage run ended in the meantime
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: schedulerRunsKey(variables.scheduler_id) });
    },
  });

  return {
    answerStageRun: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

/**
 * Cancels the form a stage run waits for, which ends the run as failed.
 */
export function useCancelStageRun() {
  const queryClient = useQueryClient();

  const mutation = useMutation<StageRunActionResult, Error, StageRunActionInput>({
    mutationFn: async (input) => {
      return await requestSchedulerManagerJSON(stageRunActionPath(input, 'cancel'), {
        method: 'POST',
      }) as StageRunActionResult;
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: schedulerRunsKey(variables.scheduler_id) });
    },
  });

  return {
    cancelStageRun: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}
