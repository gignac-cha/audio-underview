import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import {
  MemoryRouter,
  RouterProvider,
  createMemoryRouter,
  type RouteObject,
} from 'react-router';
import { ApiClientProvider } from '../sources/api/use-api-client.tsx';
import { sessionAtom, type StoredSession } from '../sources/state/session.ts';
import { themeAtom } from '../sources/state/theme.ts';

export interface RenderOptions {
  routes: RouteObject[];
  initialEntries?: string[];
  session?: StoredSession | null;
}

export interface RenderAppResult extends RenderResult {
  store: ReturnType<typeof createStore>;
  queryClient: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
}

/** 앱 provider 트리 + 메모리 data router로 렌더한다 (useBlocker 지원). */
export const renderApp = ({
  routes,
  initialEntries = ['/'],
  session = null,
}: RenderOptions): RenderAppResult => {
  const store = createStore();
  if (session !== null) {
    store.set(sessionAtom, session);
  }
  store.set(themeAtom, 'light');

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const router = createMemoryRouter(routes, { initialEntries });

  const result = render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>
    </JotaiProvider>,
  );

  return { ...result, store, queryClient, user: userEvent.setup() };
};

/** renderHook용 provider 래퍼 (useBlocker 미사용 훅 전용). */
export const createHookWrapper = (session: StoredSession | null = null) => {
  const store = createStore();
  if (session !== null) {
    store.set(sessionAtom, session);
  }
  store.set(themeAtom, 'light');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </JotaiProvider>
  );
  return { wrapper, store, queryClient };
};

/** 단일 컴포넌트를 지정 경로에 마운트하는 축약 헬퍼. */
export const renderComponent = (
  element: ReactNode,
  options: Omit<RenderOptions, 'routes'> & { path?: string } = {},
): RenderAppResult => {
  const path = options.path ?? '/';
  return renderApp({
    routes: [{ path, element }],
    initialEntries: options.initialEntries ?? [path],
    session: options.session,
  });
};
