import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { validateEnvironment } from './schemas/environment.ts';
import { ToastProvider } from './contexts/ToastContext.tsx';
import { Application } from './Application.tsx';
import './styles/global.scss';

const environment = validateEnvironment();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Application googleClientID={environment.VITE_GOOGLE_CLIENT_ID} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
