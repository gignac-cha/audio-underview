import '@fontsource-variable/archivo';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/global.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as JotaiProvider } from 'jotai';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { createApplicationRouter } from './Application.tsx';
import { ApiClientProvider } from './api/use-api-client.tsx';
import { Toaster } from './components/Toaster.tsx';
import { validateEnvironment } from './environment.ts';
import { createApplicationStore } from './state/store.ts';

// 부팅 시 env 스키마 검증 — 위반이면 throw로 기동 중단.
validateEnvironment();

const store = createApplicationStore();
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 1 },
  },
});
const router = createApplicationRouter();

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <JotaiProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider>
          <RouterProvider router={router} />
          <Toaster />
        </ApiClientProvider>
      </QueryClientProvider>
    </JotaiProvider>
  </StrictMode>,
);
