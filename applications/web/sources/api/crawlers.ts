import {
  createListEnvelopeSchema,
  crawlerSchema,
  type Crawler,
  type PlainObject,
} from '@audio-underview/schemas';
import {
  skipToken,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useAtomValue } from 'jotai';
import { isAuthenticatedAtom } from '../state/session.ts';
import { queryKeys } from './query-keys.ts';
import { useApiClient } from './use-api-client.tsx';

export const CRAWLERS_PAGE_SIZE = 20;

const crawlerListSchema = createListEnvelopeSchema(crawlerSchema);

export interface CreateCrawlerBody {
  name: string;
  url_pattern?: string;
  code: string;
}

export type UpdateCrawlerBody =
  | {
      type: 'web';
      name: string;
      url_pattern: string;
      code: string;
      output_schema: PlainObject;
    }
  | {
      type: 'data';
      name: string;
      code: string;
      input_schema: PlainObject;
      output_schema: PlainObject;
    };

/** 크롤러 목록 — infinite query + 명시적 Load More. */
export const useListCrawlers = () => {
  const client = useApiClient();
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  const query = useInfiniteQuery({
    queryKey: queryKeys.crawlers,
    enabled: isAuthenticated,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers', {
        query: { offset: pageParam, limit: CRAWLERS_PAGE_SIZE },
        schema: crawlerListSchema,
      }),
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
  });

  return {
    crawlers: query.data?.pages.flatMap((page) => page.data) ?? [],
    total: query.data?.pages[0]?.total ?? 0,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
};

/** 단건 크롤러 — id 없거나 미인증이면 skipToken으로 비활성. */
export const useGetCrawler = (id: string | undefined) => {
  const client = useApiClient();
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);

  const query = useQuery({
    queryKey: queryKeys.crawler(id ?? 'unknown'),
    queryFn:
      id === undefined || !isAuthenticated
        ? skipToken
        : () =>
            client.request('VITE_CRAWLER_MANAGER_WORKER_URL', `/crawlers/${id}`, {
              schema: crawlerSchema,
            }),
  });

  return {
    crawler: query.data,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
};

export const useCreateCrawler = () => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (body: CreateCrawlerBody) =>
      client.request('VITE_CRAWLER_MANAGER_WORKER_URL', '/crawlers', {
        method: 'POST',
        body,
        schema: crawlerSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlers });
    },
  });

  return {
    createCrawler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

export const useUpdateCrawler = () => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateCrawlerBody }) =>
      client.request('VITE_CRAWLER_MANAGER_WORKER_URL', `/crawlers/${id}`, {
        method: 'PUT',
        body,
        schema: crawlerSchema,
      }),
    onSuccess: (updated: Crawler) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlers });
      queryClient.setQueryData(queryKeys.crawler(updated.id), updated);
    },
  });

  return {
    updateCrawler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};

export const useDeleteCrawler = () => {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (id: string) =>
      client.request('VITE_CRAWLER_MANAGER_WORKER_URL', `/crawlers/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.crawlers });
    },
  });

  return {
    deleteCrawler: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
};
