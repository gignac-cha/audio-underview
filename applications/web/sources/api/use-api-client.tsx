import { useQueryClient } from '@tanstack/react-query';
import { useStore } from 'jotai';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { sessionAtom } from '../state/session.ts';
import { ApiClient } from './client.ts';

const ApiClientContext = createContext<ApiClient | null>(null);

/**
 * ApiClient를 앱 트리에 제공한다. jotai store(세션 단일 소스)와 QueryClient를 묶어
 * 로그아웃 시 세션 폐기 + 쿼리 캐시 초기화까지 담당한다.
 */
export const ApiClientProvider = ({ children }: { children: ReactNode }) => {
  const store = useStore();
  const queryClient = useQueryClient();

  const client = useMemo(
    () =>
      new ApiClient(store, () => {
        store.set(sessionAtom, null);
        queryClient.clear();
      }),
    [store, queryClient],
  );

  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
};

export const useApiClient = (): ApiClient => {
  const client = useContext(ApiClientContext);
  if (client === null) {
    throw new Error('useApiClient must be used within an ApiClientProvider.');
  }
  return client;
};
