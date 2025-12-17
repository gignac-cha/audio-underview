import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
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
      <GoogleOAuthProvider clientId={environment.VITE_GOOGLE_CLIENT_ID}>
        <ToastProvider>
          <Application />
        </ToastProvider>
      </GoogleOAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
