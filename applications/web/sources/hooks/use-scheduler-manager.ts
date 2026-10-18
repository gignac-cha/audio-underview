import { useMutation, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadAuthenticationData } from '@audio-underview/sign-provider';
import type { FanOutStrategy, SchedulerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import {
  DEFAULT_PAGE_LIMIT,
  requestSchedulerManagerJSON,
  type PaginatedParameters,
  type PaginatedResponse,
} from './scheduler-manager-request.ts';

// ─── Types ─────────────────────────────────────────────────────

interface CreateSchedulerInput {
  name: string;
  cron_expression?: string | null;
  timezone?: string;
  is_enabled?: boolean;
}

interface UpdateSchedulerInput {
  id: string;
  name?: string;
  cron_expression?: string | null;
  timezone?: string;
  is_enabled?: boolean;
}

// A crawler stage is the default type, so its requests leave stage_type out
interface CreateCrawlerStageInput {
  scheduler_id: string;
  stage_type?: 'crawler';
  crawler_id: string;
  stage_order: number;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string;
  fan_out_strategy?: FanOutStrategy;
}

interface CreateTaskGroupStageInput {
  scheduler_id: string;
  stage_type: 'task_group';
  task_group_id: string;
  task_group_version: number;
  settings: Record<string, unknown>;
  stage_order: number;
}

export type CreateStageInput = CreateCrawlerStageInput | CreateTaskGroupStageInput;

// The crawler fields apply to a crawler stage and the task group fields to a task group stage
export interface UpdateStageInput {
  scheduler_id: string;
  stage_id: string;
  crawler_id?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string | null;
  fan_out_strategy?: FanOutStrategy;
  task_group_version?: number;
  settings?: Record<string, unknown>;
}

interface DeleteStageInput {
  scheduler_id: string;
  stage_id: string;
}

interface ReorderStagesInput {
  scheduler_id: string;
  stage_ids: string[];
}

// ─── Query keys ────────────────────────────────────────────────

export const SCHEDULERS_QUERY_KEY = ['schedulers'] as const;

export function schedulerDetailKey(id: string) {
  return ['schedulers', id] as const;
}

export function stagesKey(schedulerID: string) {
  return ['schedulers', schedulerID, 'stages'] as const;
}

// ─── Scheduler hooks ──────────────────────────────────────────

export function useCreateScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerRow, Error, CreateSchedulerInput>({
    mutationFn: async (input) => {
      return await requestSchedulerManagerJSON('/schedulers', {
        method: 'POST',
        body: input,
      }) as SchedulerRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY });
    },
  });

  return {
    createScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

export function useListSchedulers() {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? undefined;

  const query = useInfiniteQuery<
    PaginatedResponse<SchedulerRow>,
    Error,
    { pages: PaginatedResponse<SchedulerRow>[] },
    readonly string[],
    PaginatedParameters
  >({
    queryKey: SCHEDULERS_QUERY_KEY,
    queryFn: async ({ pageParam }) => {
      const searchParameters = new URLSearchParams({
        offset: String(pageParam.offset),
        limit: String(pageParam.limit),
      });
      return await requestSchedulerManagerJSON(`/schedulers?${searchParameters.toString()}`) as PaginatedResponse<SchedulerRow>;
    },
    initialPageParam: { offset: 0, limit: DEFAULT_PAGE_LIMIT },
    getNextPageParam: (lastPage) => {
      if (lastPage.offset + lastPage.limit < lastPage.total) {
        return { offset: lastPage.offset + lastPage.limit, limit: lastPage.limit };
      }
      return undefined;
    },
    enabled: !!accessToken,
  });

  const schedulers = query.data?.pages.flatMap((page) => page.data) ?? [];

  return {
    schedulers,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

export function useGetScheduler(id: string | undefined) {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? undefined;

  const query = useQuery<SchedulerRow, Error>({
    queryKey: schedulerDetailKey(id ?? ''),
    queryFn: async () => {
      return await requestSchedulerManagerJSON(`/schedulers/${id}`) as SchedulerRow;
    },
    enabled: !!accessToken && !!id,
  });

  return {
    scheduler: query.data ?? undefined,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
}

export function useUpdateScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerRow, Error, UpdateSchedulerInput>({
    mutationFn: async ({ id, ...payload }) => {
      return await requestSchedulerManagerJSON(`/schedulers/${id}`, {
        method: 'PUT',
        body: payload,
      }) as SchedulerRow;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY });
      queryClient.setQueryData(schedulerDetailKey(data.id), data);
    },
  });

  return {
    updateScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

export function useDeleteScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await requestSchedulerManagerJSON(`/schedulers/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY });
    },
  });

  return {
    deleteScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

// ─── Stage hooks ──────────────────────────────────────────────

export function useListStages(schedulerID: string | undefined) {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? undefined;

  const query = useQuery<{ data: SchedulerStageRow[] }, Error>({
    queryKey: stagesKey(schedulerID ?? ''),
    queryFn: async () => {
      return await requestSchedulerManagerJSON(`/schedulers/${schedulerID}/stages`) as { data: SchedulerStageRow[] };
    },
    enabled: !!accessToken && !!schedulerID,
  });

  return {
    stages: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
}

export function useCreateStage() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerStageRow, Error, CreateStageInput>({
    mutationFn: async ({ scheduler_id, ...payload }) => {
      return await requestSchedulerManagerJSON(`/schedulers/${scheduler_id}/stages`, {
        method: 'POST',
        body: payload,
      }) as SchedulerStageRow;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    createStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

export function useUpdateStage() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerStageRow, Error, UpdateStageInput>({
    mutationFn: async ({ scheduler_id, stage_id, ...payload }) => {
      return await requestSchedulerManagerJSON(`/schedulers/${scheduler_id}/stages/${stage_id}`, {
        method: 'PUT',
        body: payload,
      }) as SchedulerStageRow;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    updateStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

export function useDeleteStage() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, DeleteStageInput>({
    mutationFn: async ({ scheduler_id, stage_id }) => {
      await requestSchedulerManagerJSON(`/schedulers/${scheduler_id}/stages/${stage_id}`, { method: 'DELETE' });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    deleteStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

export function useReorderStages() {
  const queryClient = useQueryClient();

  const mutation = useMutation<{ data: SchedulerStageRow[] }, Error, ReorderStagesInput>({
    mutationFn: async ({ scheduler_id, stage_ids }) => {
      return await requestSchedulerManagerJSON(`/schedulers/${scheduler_id}/stages/reorder`, {
        method: 'PUT',
        body: { stage_ids },
      }) as { data: SchedulerStageRow[] };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    reorderStages: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}
