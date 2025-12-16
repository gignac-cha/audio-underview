import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Application } from './Application.tsx';
import './styles/global.scss';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});

const googleClientID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

if (!googleClientID) {
  console.error('VITE_GOOGLE_CLIENT_ID environment variable is not set');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <GoogleOAuthProvider clientId={googleClientID || ''}>
        <Application />
      </GoogleOAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
