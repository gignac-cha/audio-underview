import { useMutation, useQuery, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { loadAuthenticationData } from '@audio-underview/sign-provider';
import type { CrawlerRow } from '@audio-underview/supabase-connector';

interface ListCrawlersParameters {
  offset: number;
  limit: number;
}

interface ListCrawlersResponse {
  data: CrawlerRow[];
  total: number;
  offset: number;
  limit: number;
}

interface CreateCrawlerInput {
  name: string;
  url_pattern: string;
  code: string;
}

function getAccessToken(): string {
  const authenticationData = loadAuthenticationData();
  if (!authenticationData) {
    throw new Error('Not authenticated');
  }
  return authenticationData.credential;
}

function getBaseURL(): string {
  const baseURL = import.meta.env.VITE_CRAWLER_MANAGER_WORKER_URL;
  if (!baseURL) {
    throw new Error('VITE_CRAWLER_MANAGER_WORKER_URL is not configured');
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

async function createCrawlerRequest(input: CreateCrawlerInput): Promise<CrawlerRow> {
  const baseURL = getBaseURL();
  const accessToken = getAccessToken();

  const response = await fetch(`${baseURL}/crawlers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(input),
  });

  const body = await parseResponseJSON(response);

  if (!response.ok) {
    throwResponseError(body, response.status);
  }

  return body as unknown as CrawlerRow;
}

async function listCrawlersRequest(parameters: ListCrawlersParameters): Promise<ListCrawlersResponse> {
  const baseURL = getBaseURL();
  const accessToken = getAccessToken();

  const searchParameters = new URLSearchParams({
    offset: String(parameters.offset),
    limit: String(parameters.limit),
  });

  const response = await fetch(`${baseURL}/crawlers?${searchParameters.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const body = await parseResponseJSON(response);

  if (!response.ok) {
    throwResponseError(body, response.status);
  }

  return body as unknown as ListCrawlersResponse;
}

async function deleteCrawlerRequest(id: string): Promise<void> {
  const baseURL = getBaseURL();
  const accessToken = getAccessToken();

  const response = await fetch(`${baseURL}/crawlers/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await parseResponseJSON(response);
    throwResponseError(body, response.status);
  }
}

const CRAWLERS_QUERY_KEY = ['crawlers'] as const;

export function useCreateCrawler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<CrawlerRow, Error, CreateCrawlerInput>({
    mutationFn: createCrawlerRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CRAWLERS_QUERY_KEY });
    },
  });

  return {
    createCrawler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}

const DEFAULT_PAGE_LIMIT = 20;

export function useListCrawlers() {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? null;

  const query = useInfiniteQuery<ListCrawlersResponse, Error, { pages: ListCrawlersResponse[] }, readonly string[], ListCrawlersParameters>({
    queryKey: CRAWLERS_QUERY_KEY,
    queryFn: ({ pageParam }) => listCrawlersRequest(pageParam),
    initialPageParam: { offset: 0, limit: DEFAULT_PAGE_LIMIT },
    getNextPageParam: (lastPage) => {
      if (lastPage.offset + lastPage.limit < lastPage.total) {
        return { offset: lastPage.offset + lastPage.limit, limit: lastPage.limit };
      }
      return undefined;
    },
    enabled: !!accessToken,
  });

  const crawlers = query.data?.pages.flatMap((page) => page.data) ?? [];

  return {
    crawlers,
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}

export function useDeleteCrawler() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, string>({
    mutationFn: deleteCrawlerRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CRAWLERS_QUERY_KEY });
    },
  });

  return {
    deleteCrawler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}
