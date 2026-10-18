import { useEffect, useRef } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SchedulerRunRow,
  SchedulerRunStatus,
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
 * A stage run without its input, output and logs, which can be large. The connector's
 * SchedulerStageRunSummary is Omit<> of a row type with an index signature, which drops the named
 * fields, so it is built here from the named fields only.
 */
export type StageRunSummary = Omit<WithoutIndexSignature<SchedulerStageRunRow>, 'input' | 'output' | 'logs'>;

/** A run with the summaries of its stage runs */
export type SchedulerRunDetail = SchedulerRunRow & { stage_runs: StageRunSummary[] };

/** What the manual run answers once the run is recorded */
export interface SchedulerExecution {
  run_id: string;
  status: SchedulerRunStatus;
  error: string | null;
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
  'completed',
  'failed',
  'partially_failed',
  'skipped',
];

export function isInProgress(status: SchedulerRunStatus | undefined): boolean {
  return status === 'pending' || status === 'running';
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

  return {
    runs,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

/**
 * One run with its stage runs. Read again while the run is pending or running.
 */
export function useGetRun(schedulerID: string | undefined, runID: string | undefined, options: RefreshOptions = {}) {
  const refreshIntervalMilliseconds = options.refreshIntervalMilliseconds ?? RUN_REFRESH_INTERVAL_MILLISECONDS;

  const query = useQuery<SchedulerRunDetail, Error>({
    queryKey: runDetailKey(schedulerID ?? '', runID ?? ''),
    queryFn: async () => {
      return await requestSchedulerManagerJSON(`/schedulers/${schedulerID}/runs/${runID}`) as SchedulerRunDetail;
    },
    enabled: hasAccessToken() && !!schedulerID && !!runID,
    refetchInterval: (runQuery) => (isInProgress(runQuery.state.data?.status) ? refreshIntervalMilliseconds : false),
  });

  return {
    run: query.data ?? undefined,
    isLoading: query.isLoading,
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

  return {
    stageRun: query.data ?? undefined,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
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
