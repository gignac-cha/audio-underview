import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadAuthenticationData } from '@audio-underview/sign-provider';
import type { CrawlerRow } from '@audio-underview/supabase-connector';

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

async function parseResponseJSON(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Request failed with status ${response.status}`);
  }
}

function throwResponseError(body: Record<string, unknown>, status: number): never {
  const errorMessage = body.error_description ?? body.error ?? `Request failed with status ${status}`;
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

async function listCrawlersRequest(): Promise<CrawlerRow[]> {
  const baseURL = getBaseURL();
  const accessToken = getAccessToken();

  const response = await fetch(`${baseURL}/crawlers`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const body = await parseResponseJSON(response);

  if (!response.ok) {
    throwResponseError(body, response.status);
  }

  return body as unknown as CrawlerRow[];
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

export function useListCrawlers() {
  const authenticationData = loadAuthenticationData();
  const accessToken = authenticationData?.credential ?? null;

  const query = useQuery<CrawlerRow[], Error>({
    queryKey: CRAWLERS_QUERY_KEY,
    queryFn: listCrawlersRequest,
    enabled: !!accessToken,
  });

  return {
    crawlers: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? null,
    refetch: query.refetch,
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
