import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { loadAuthenticationData } from '@audio-underview/sign-provider';

interface CrawlerRow {
  id: string;
  user_uuid: string;
  name: string;
  url_pattern: string;
  code: string;
  created_at: string;
  updated_at: string;
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

  const body = await response.json();

  if (!response.ok) {
    const errorMessage = body.error_description ?? body.error ?? `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return body as CrawlerRow;
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

  const body = await response.json();

  if (!response.ok) {
    const errorMessage = body.error_description ?? body.error ?? `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return body as CrawlerRow[];
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
    const body = await response.json();
    const errorMessage = body.error_description ?? body.error ?? `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
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
  const query = useQuery<CrawlerRow[], Error>({
    queryKey: CRAWLERS_QUERY_KEY,
    queryFn: listCrawlersRequest,
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
