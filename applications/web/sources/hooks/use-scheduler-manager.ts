import { useMutation, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadAuthenticationData } from '@audio-underview/sign-provider';
import type { SchedulerRow, SchedulerStageRow, SchedulerRunRow } from '@audio-underview/supabase-connector';

const FETCH_TIMEOUT_MS = 30_000;

// ─── Shared helpers ────────────────────────────────────────────

function getAccessToken(): string {
  const authenticationData = loadAuthenticationData();
  if (!authenticationData) {
    throw new Error('Authentication required. Please sign in.');
  }
  return authenticationData.credential;
}

function getBaseURL(): string {
  const baseURL = import.meta.env.VITE_SCHEDULER_MANAGER_WORKER_URL;
  if (!baseURL) {
    throw new Error('Service is not available. Please try again later.');
  }
  return baseURL;
}

async function parseResponseJSON(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Request failed with status ${response.status}`);
  }
}

function throwResponseError(body: unknown, status: number): never {
  const record = body as Record<string, unknown> | null | undefined;
  const errorMessage = record?.error_description ?? record?.error ?? `Request failed with status ${status}`;
  throw new Error(String(errorMessage));
}

async function authenticatedFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const baseURL = getBaseURL();
  const accessToken = getAccessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };

  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const body = await parseResponseJSON(response);

  if (!response.ok) {
    throwResponseError(body, response.status);
  }

  return body;
}

// ─── Types ─────────────────────────────────────────────────────

interface PaginatedParameters {
  offset: number;
  limit: number;
}

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  offset: number;
  limit: number;
}

interface CreateSchedulerInput {
  name: string;
  cron_expression?: string | null;
  is_enabled?: boolean;
}

interface UpdateSchedulerInput {
  id: string;
  name?: string;
  cron_expression?: string | null;
  is_enabled?: boolean;
}

interface CreateStageInput {
  scheduler_id: string;
  crawler_id: string;
  stage_order: number;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string;
}

interface UpdateStageInput {
  scheduler_id: string;
  stage_id: string;
  crawler_id?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string | null;
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

const SCHEDULERS_QUERY_KEY = ['schedulers'] as const;

function schedulerDetailKey(id: string) {
  return ['schedulers', id] as const;
}

function stagesKey(schedulerID: string) {
  return ['schedulers', schedulerID, 'stages'] as const;
}

function runsKey(schedulerID: string) {
  return ['schedulers', schedulerID, 'runs'] as const;
}

// ─── Scheduler hooks ──────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 20;

export function useCreateScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerRow, Error, CreateSchedulerInput>({
    mutationFn: async (input) => {
      return await authenticatedFetch('/schedulers', {
        method: 'POST',
        body: JSON.stringify(input),
      }) as SchedulerRow;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY });
    },
  });

  return {
    createScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

export function useListSchedulers() {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? null;

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
      return await authenticatedFetch(`/schedulers?${searchParameters.toString()}`) as PaginatedResponse<SchedulerRow>;
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
    error: query.error ?? null,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

export function useGetScheduler(id: string | undefined) {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? null;

  const query = useQuery<SchedulerRow, Error>({
    queryKey: schedulerDetailKey(id ?? ''),
    queryFn: async () => {
      return await authenticatedFetch(`/schedulers/${id}`) as SchedulerRow;
    },
    enabled: !!accessToken && !!id,
  });

  return {
    scheduler: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: query.refetch,
  };
}

export function useUpdateScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerRow, Error, UpdateSchedulerInput>({
    mutationFn: async ({ id, ...payload }) => {
      return await authenticatedFetch(`/schedulers/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
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
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

export function useDeleteScheduler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, string>({
    mutationFn: async (id) => {
      await authenticatedFetch(`/schedulers/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SCHEDULERS_QUERY_KEY });
    },
  });

  return {
    deleteScheduler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

// ─── Stage hooks ──────────────────────────────────────────────

export function useListStages(schedulerID: string | undefined) {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? null;

  const query = useQuery<{ data: SchedulerStageRow[] }, Error>({
    queryKey: stagesKey(schedulerID ?? ''),
    queryFn: async () => {
      return await authenticatedFetch(`/schedulers/${schedulerID}/stages`) as { data: SchedulerStageRow[] };
    },
    enabled: !!accessToken && !!schedulerID,
  });

  return {
    stages: query.data?.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: query.refetch,
  };
}

export function useCreateStage() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerStageRow, Error, CreateStageInput>({
    mutationFn: async ({ scheduler_id, ...payload }) => {
      return await authenticatedFetch(`/schedulers/${scheduler_id}/stages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }) as SchedulerStageRow;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    createStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

export function useUpdateStage() {
  const queryClient = useQueryClient();

  const mutation = useMutation<SchedulerStageRow, Error, UpdateStageInput>({
    mutationFn: async ({ scheduler_id, stage_id, ...payload }) => {
      return await authenticatedFetch(`/schedulers/${scheduler_id}/stages/${stage_id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }) as SchedulerStageRow;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    updateStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

export function useDeleteStage() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, DeleteStageInput>({
    mutationFn: async ({ scheduler_id, stage_id }) => {
      await authenticatedFetch(`/schedulers/${scheduler_id}/stages/${stage_id}`, { method: 'DELETE' });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    deleteStage: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

export function useReorderStages() {
  const queryClient = useQueryClient();

  const mutation = useMutation<{ data: SchedulerStageRow[] }, Error, ReorderStagesInput>({
    mutationFn: async ({ scheduler_id, stage_ids }) => {
      return await authenticatedFetch(`/schedulers/${scheduler_id}/stages/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ stage_ids }),
      }) as { data: SchedulerStageRow[] };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: stagesKey(variables.scheduler_id) });
    },
  });

  return {
    reorderStages: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

// ─── Run hooks ────────────────────────────────────────────────

export function useListRuns(schedulerID: string | undefined) {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? null;

  const query = useInfiniteQuery<
    PaginatedResponse<SchedulerRunRow>,
    Error,
    { pages: PaginatedResponse<SchedulerRunRow>[] },
    readonly string[],
    PaginatedParameters
  >({
    queryKey: runsKey(schedulerID ?? ''),
    queryFn: async ({ pageParam }) => {
      const searchParameters = new URLSearchParams({
        offset: String(pageParam.offset),
        limit: String(pageParam.limit),
      });
      return await authenticatedFetch(
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
    enabled: !!accessToken && !!schedulerID,
  });

  const runs = query.data?.pages.flatMap((page) => page.data) ?? [];

  return {
    runs,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
