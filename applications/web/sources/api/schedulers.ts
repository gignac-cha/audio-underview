import {
  createListEnvelopeSchema,
  executeSchedulerResponseSchema,
  schedulerRunSchema,
  schedulerSchema,
  schedulerStageSchema,
  type CreateSchedulerStageBody,
  type Scheduler,
  type SchedulerStage,
  type UpdateSchedulerStageBody,
} from '@audio-underview/schemas';
import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { z } from 'zod';
import { isAuthenticatedAtom } from '../state/session.ts';
import { queryKeys } from './query-keys.ts';
import { useApiClient } from './use-api-client.tsx';

export const SCHEDULERS_PAGE_SIZE = 20;
export const RUNS_PAGE_SIZE = 20;

const SERVICE = 'VITE_SCHEDULER_MANAGER_WORKER_URL' as const;

const schedulerListSchema = createListEnvelopeSchema(schedulerSchema);
const stageListSchema = z.object({ data: z.array(schedulerStageSchema) });
const runListSchema = createListEnvelopeSchema(schedulerRunSchema);

export interface CreateSchedulerBody {
  name: string;
  cron_expression?: string | null;
  is_enabled?: boolean;
}

export interface UpdateSchedulerBody {
  name?: string;
  cron_expression?: string | null;
  is_enabled?: boolean;
}

// ---- schedulers ----

export const useListSchedulers = () => {
  const client = useApiClient();
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  const query = useInfiniteQuery({
    queryKey: queryKeys.schedulers,
    enabled: isAuthenticated,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client.request(SERVICE, '/schedulers', {
        query: { offset: pageParam, limit: SCHEDULERS_PAGE_SIZE },
        schema: schedulerListSchema,
      }),
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
  });

  return {
    schedulers: query.data?.pages.flatMap((page) => page.data) ?? [],
    total: query.data?.pages[0]?.total ?? 0,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
};

export const useGetScheduler = (id: string | undefined) => {
  const client = useApiClient();
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  const query = useQuery({
    queryKey: queryKeys.scheduler(id ?? 'unknown'),
    queryFn:
      id === undefined || !isAuthenticated
        ? skipToken
        : () => client.request(SERVICE, `/schedulers/${id}`, { schema: schedulerSchema }),
  });

  return {
    scheduler: query.data,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
};

export const useCreateScheduler = () => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: CreateSchedulerBody) =>
      client.request(SERVICE, '/schedulers', { method: 'POST', body, schema: schedulerSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulers });
    },
  });

  return {
    createScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

export const useUpdateScheduler = (id: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: UpdateSchedulerBody) =>
      client.request(SERVICE, `/schedulers/${id}`, { method: 'PUT', body, schema: schedulerSchema }),
    onSuccess: (updated: Scheduler) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulers });
      queryClient.setQueryData(queryKeys.scheduler(id), updated);
    },
  });

  return {
    updateScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

export const useDeleteScheduler = () => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (id: string) => client.request(SERVICE, `/schedulers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulers });
    },
  });

  return {
    deleteScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

/** 수동 실행 트리거 (개선 §9) — 동기 실행 결과 반환, run history invalidate. */
export const useExecuteScheduler = (id: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      client.request(SERVICE, `/schedulers/${id}/execute`, {
        method: 'POST',
        schema: executeSchedulerResponseSchema,
        timeoutMilliseconds: 60_000,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulerRuns(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.scheduler(id) });
    },
  });

  return {
    executeScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

// ---- stages ----

export const useListStages = (schedulerID: string | undefined) => {
  const client = useApiClient();
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  const query = useQuery({
    queryKey: queryKeys.schedulerStages(schedulerID ?? 'unknown'),
    queryFn:
      schedulerID === undefined || !isAuthenticated
        ? skipToken
        : async () => {
            const response = await client.request(SERVICE, `/schedulers/${schedulerID}/stages`, {
              schema: stageListSchema,
            });
            return response.data;
          },
  });

  return {
    stages: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
};

export const useCreateStage = (schedulerID: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: CreateSchedulerStageBody) =>
      client.request(SERVICE, `/schedulers/${schedulerID}/stages`, { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulerStages(schedulerID) });
    },
  });

  return {
    createStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

export const useUpdateStage = (schedulerID: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ stageID, body }: { stageID: string; body: UpdateSchedulerStageBody }) =>
      client.request(SERVICE, `/schedulers/${schedulerID}/stages/${stageID}`, {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulerStages(schedulerID) });
    },
  });

  return {
    updateStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

export const useDeleteStage = (schedulerID: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (stageID: string) =>
      client.request(SERVICE, `/schedulers/${schedulerID}/stages/${stageID}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.schedulerStages(schedulerID) });
    },
  });

  return {
    deleteStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

/** 전체 stage 순서를 재부여. optimistic UI는 StageList에서, 실패 시 rollback. */
export const useReorderStages = (schedulerID: string) => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (stageIDs: string[]) =>
      client.request(SERVICE, `/schedulers/${schedulerID}/stages/reorder`, {
        method: 'PUT',
        body: { stage_ids: stageIDs },
        schema: stageListSchema,
      }),
    onSuccess: (response: { data: SchedulerStage[] }) => {
      queryClient.setQueryData(queryKeys.schedulerStages(schedulerID), response.data);
    },
  });

  return {
    reorderStages: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

// ---- runs ----

export const useListRuns = (schedulerID: string | undefined) => {
  const client = useApiClient();
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  const query = useInfiniteQuery({
    queryKey: queryKeys.schedulerRuns(schedulerID ?? 'unknown'),
    enabled: schedulerID !== undefined && isAuthenticated,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client.request(SERVICE, `/schedulers/${schedulerID ?? ''}/runs`, {
        query: { offset: pageParam, limit: RUNS_PAGE_SIZE },
        schema: runListSchema,
      }),
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
  });

  return {
    runs: query.data?.pages.flatMap((page) => page.data) ?? [],
    total: query.data?.pages[0]?.total ?? 0,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
};
