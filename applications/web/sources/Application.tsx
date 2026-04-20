import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { AuthenticationProvider } from './contexts/AuthenticationContext.tsx';
import { useAuthentication } from './hooks/use-authentication.ts';
import { type OAuthProviderID } from '@audio-underview/sign-provider';
import { SignInPage } from './pages/SignInPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { CrawlersPage } from './pages/CrawlersPage.tsx';
import { CrawlerNewPage } from './pages/CrawlerNewPage.tsx';
import { CrawlerDetailPage } from './pages/CrawlerDetailPage.tsx';
import { SchedulersPage } from './pages/SchedulersPage.tsx';
import { SchedulerDetailPage } from './pages/SchedulerDetailPage.tsx';
import { AuthenticationCallbackPage } from './pages/AuthenticationCallbackPage.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';

const ENABLED_PROVIDERS: OAuthProviderID[] = [
  'google',
  'apple',
  'microsoft',
  'facebook',
  'github',
  'discord',
  'kakao',
  'naver',
];

function RootRedirect() {
  const { isAuthenticated, isLoading } = useAuthentication();

  if (isLoading) {
    return (
      <div className="loading-container">
        <p>Loading...</p>
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/home" replace />;
  }

  return <Navigate to="/sign/in" replace />;
}

function ApplicationRoutes() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/sign/in" element={<SignInPage />} />
      <Route path="/authentication/callback" element={<AuthenticationCallbackPage />} />
      <Route
        path="/home"
        element={
          <ProtectedRoute>
            <HomePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/crawlers"
        element={
          <ProtectedRoute>
            <CrawlersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/crawlers/new"
        element={
          <ProtectedRoute>
            <CrawlerNewPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/crawlers/:id"
        element={
          <ProtectedRoute>
            <CrawlerDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/schedulers"
        element={
          <ProtectedRoute>
            <SchedulersPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/schedulers/:id"
        element={
          <ProtectedRoute>
            <SchedulerDetailPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

interface ApplicationProps {
  googleClientID: string;
  googleWorkerURL?: string;
  githubWorkerURL?: string;
}

export function Application({ googleClientID, googleWorkerURL, githubWorkerURL }: ApplicationProps) {
  return (
    <BrowserRouter>
      <AuthenticationProvider
        googleClientID={googleClientID}
        googleWorkerURL={googleWorkerURL}
        githubWorkerURL={githubWorkerURL}
        enabledProviders={ENABLED_PROVIDERS}
      >
        <ApplicationRoutes />
      </AuthenticationProvider>
    </BrowserRouter>
  );
}
