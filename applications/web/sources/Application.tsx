import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import {
  AuthenticationProvider,
  useAuthentication,
  type OAuthProviderID,
} from './contexts/AuthenticationContext.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { CrawlersPage } from './pages/CrawlersPage.tsx';
import { CrawlerNewPage } from './pages/CrawlerNewPage.tsx';
import { AuthCallbackPage } from './pages/AuthCallbackPage.tsx';
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
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
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
    </Routes>
  );
}

interface ApplicationProps {
  googleClientID: string;
  githubWorkerURL?: string;
}

export function Application({ googleClientID, githubWorkerURL }: ApplicationProps) {
  return (
    <BrowserRouter>
      <AuthenticationProvider
        googleClientID={googleClientID}
        githubWorkerURL={githubWorkerURL}
        enabledProviders={ENABLED_PROVIDERS}
      >
        <ApplicationRoutes />
      </AuthenticationProvider>
    </BrowserRouter>
  );
}
