import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ZodType } from 'zod';
import type { CrawlerType } from '@audio-underview/supabase-connector';
import {
  crawlerRunDetailSchema,
  crawlerRunExecutionSchema,
  crawlerRunFailedSchema,
  crawlerRunListSchema,
  type CrawlerRunDetail,
  type CrawlerRunExecution,
  type CrawlerRunList,
} from '../schemas/crawler-runs.ts';
import {
  LIST_TIMEOUT_MILLISECONDS,
  RUN_TIMEOUT_MILLISECONDS,
  fetchCrawlerManager,
  hasAccessToken,
  parseResponseJSON,
  requestCrawlerManagerJSON,
  throwResponseError,
} from './crawler-manager-request.ts';

// A file can be larger than a page of JSON, so its download gets more time than a list
const DOWNLOAD_TIMEOUT_MILLISECONDS = 120_000;
const DEFAULT_PAGE_LIMIT = 20;

/**
 * The fields of the editor that a test run uses in place of the saved crawler's. A field left out
 * keeps the saved value, or the default of a crawler that is not saved.
 */
export interface CrawlerDraft {
  code: string;
  url_pattern?: string;
  input_schema?: Record<string, unknown>;
  environment_variable_names?: string[];
}

/**
 * What a run runs:
 * - saved: the saved crawler as it is (POST /crawlers/:id/runs)
 * - saved-draft: the saved crawler with the draft laid over it (POST /crawlers/:id/test-runs)
 * - new-draft: a crawler that is not saved yet (POST /crawler-test-runs)
 *
 * input is sent as it is when it is not undefined; without it the crawler manager builds the input
 * from the input schema.
 */
export type RunCrawlerRequest =
  | { target: 'saved'; crawlerID: string; input?: unknown }
  | ({ target: 'saved-draft'; crawlerID: string; input?: unknown } & CrawlerDraft)
  | ({ target: 'new-draft'; type: CrawlerType; input?: unknown } & CrawlerDraft);

function buildRunRequest(request: RunCrawlerRequest): { path: string; body: Record<string, unknown> } {
  switch (request.target) {
    case 'saved':
      return { path: `/crawlers/${request.crawlerID}/runs`, body: { input: request.input } };
    case 'saved-draft':
      return {
        path: `/crawlers/${request.crawlerID}/test-runs`,
        body: {
          code: request.code,
          url_pattern: request.url_pattern,
          input_schema: request.input_schema,
          environment_variable_names: request.environment_variable_names,
          input: request.input,
        },
      };
    case 'new-draft':
      return {
        path: '/crawler-test-runs',
        body: {
          type: request.type,
          code: request.code,
          url_pattern: request.url_pattern,
          input_schema: request.input_schema,
          environment_variable_names: request.environment_variable_names,
          input: request.input,
        },
      };
  }
}

function parseResponse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error('The server sent a response this page cannot read.');
  }
  return result.data;
}

/**
 * A run that failed is a result, not an exception: it answers a 4xx or 5xx status with the run's
 * logs. Any other answer that is not 2xx throws the error_description of the response.
 */
async function runCrawlerRequest(request: RunCrawlerRequest): Promise<CrawlerRunExecution> {
  const { path, body } = buildRunRequest(request);
  const response = await fetchCrawlerManager(path, {
    method: 'POST',
    body,
    timeoutMilliseconds: RUN_TIMEOUT_MILLISECONDS,
  });
  const responseBody = await parseResponseJSON(response);

  const failed = crawlerRunFailedSchema.safeParse(responseBody);
  if (failed.success) {
    return failed.data;
  }
  if (!response.ok) {
    throwResponseError(responseBody, response.status);
  }
  return parseResponse(crawlerRunExecutionSchema, responseBody);
}

// A crawler id is null for the runs of a crawler that was never saved
const CRAWLER_RUNS_QUERY_KEY = ['crawler-runs'] as const;
const CRAWLER_RUN_QUERY_KEY = ['crawler-run'] as const;

function crawlerRunsKey(crawlerID: string | null) {
  return crawlerID === null
    ? ([...CRAWLER_RUNS_QUERY_KEY, 'unsaved'] as const)
    : ([...CRAWLER_RUNS_QUERY_KEY, 'crawler', crawlerID] as const);
}

function crawlerRunKey(crawlerID: string | null, runID: string) {
  return [...CRAWLER_RUN_QUERY_KEY, crawlerID ?? 'unsaved', runID] as const;
}

function crawlerRunsPath(crawlerID: string | null) {
  return crawlerID === null ? '/crawler-test-runs' : `/crawlers/${crawlerID}/runs`;
}

export function useRunCrawler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<CrawlerRunExecution, Error, RunCrawlerRequest>({
    mutationFn: runCrawlerRequest,
    // Settled, not succeeded: a run that timed out on the way back may still have been recorded
    onSettled: (_data, _error, request) => {
      const crawlerID = request.target === 'new-draft' ? null : request.crawlerID;
      queryClient.invalidateQueries({ queryKey: crawlerRunsKey(crawlerID) });
    },
  });

  return {
    runCrawler: mutation.mutate,
    status: mutation.status,
    result: mutation.data ?? undefined,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}

interface ListCrawlerRunsParameters {
  offset: number;
  limit: number;
}

async function listCrawlerRunsRequest(
  crawlerID: string | null,
  parameters: ListCrawlerRunsParameters,
): Promise<CrawlerRunList> {
  const searchParameters = new URLSearchParams({
    offset: String(parameters.offset),
    limit: String(parameters.limit),
  });
  const body = await requestCrawlerManagerJSON(`${crawlerRunsPath(crawlerID)}?${searchParameters.toString()}`, {
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  return parseResponse(crawlerRunListSchema, body);
}

/**
 * The runs of a crawler, direct and test, newest first; null lists the test runs of crawlers
 * that were not saved.
 */
export function useListCrawlerRuns(crawlerID: string | null) {
  const query = useInfiniteQuery<
    CrawlerRunList,
    Error,
    { pages: CrawlerRunList[] },
    readonly string[],
    ListCrawlerRunsParameters
  >({
    queryKey: crawlerRunsKey(crawlerID),
    queryFn: ({ pageParam }) => listCrawlerRunsRequest(crawlerID, pageParam),
    initialPageParam: { offset: 0, limit: DEFAULT_PAGE_LIMIT },
    getNextPageParam: (lastPage) => {
      if (lastPage.offset + lastPage.limit < lastPage.total) {
        return { offset: lastPage.offset + lastPage.limit, limit: lastPage.limit };
      }
      return undefined;
    },
    enabled: hasAccessToken(),
  });

  return {
    runs: query.data?.pages.flatMap((page) => page.data) ?? [],
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

async function getCrawlerRunRequest(crawlerID: string | null, runID: string): Promise<CrawlerRunDetail> {
  const body = await requestCrawlerManagerJSON(`${crawlerRunsPath(crawlerID)}/${runID}`, {
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  return parseResponse(crawlerRunDetailSchema, body);
}

const CRAWLER_RUN_DISABLED_KEY = [...CRAWLER_RUN_QUERY_KEY, 'disabled'] as const;

/**
 * One run with its result, logs and files. Nothing is requested while runID is undefined.
 */
export function useGetCrawlerRun(crawlerID: string | null, runID: string | undefined) {
  const query = useQuery<CrawlerRunDetail, Error>({
    queryKey: runID === undefined ? CRAWLER_RUN_DISABLED_KEY : crawlerRunKey(crawlerID, runID),
    queryFn: runID !== undefined && hasAccessToken() ? () => getCrawlerRunRequest(crawlerID, runID) : skipToken,
  });

  return {
    run: query.data ?? undefined,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
  };
}

export const FILE_NOT_FOUND_MESSAGE = 'File not found or expired';

function saveBlob(blob: Blob, fileName: string) {
  const objectURL = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectURL;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
}

async function downloadCrawlerFileRequest(fileID: string, fileName: string): Promise<void> {
  const response = await fetchCrawlerManager(`/files/${fileID}`, {
    timeoutMilliseconds: DOWNLOAD_TIMEOUT_MILLISECONDS,
  });
  if (response.status === 404) {
    throw new Error(FILE_NOT_FOUND_MESSAGE);
  }
  if (!response.ok) {
    throwResponseError(await parseResponseJSON(response), response.status);
  }
  saveBlob(await response.blob(), fileName);
}

interface DownloadCrawlerFileInput {
  fileID: string;
  // The name of the file reference; without one the file is saved under its id
  fileName: string | null;
}

export function useDownloadCrawlerFile() {
  const mutation = useMutation<void, Error, DownloadCrawlerFileInput>({
    mutationFn: ({ fileID, fileName }) => downloadCrawlerFileRequest(fileID, fileName ?? fileID),
  });

  return {
    downloadFile: mutation.mutate,
    status: mutation.status,
    error: mutation.error ?? undefined,
  };
}
