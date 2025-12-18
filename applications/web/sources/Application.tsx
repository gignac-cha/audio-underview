import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import {
  AuthenticationProvider,
  useAuthentication,
  type OAuthProviderID,
} from './contexts/AuthenticationContext.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
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
      <Route
        path="/home"
        element={
          <ProtectedRoute>
            <HomePage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

interface ApplicationProps {
  googleClientID: string;
}

export function Application({ googleClientID }: ApplicationProps) {
  return (
    <BrowserRouter>
      <AuthenticationProvider googleClientID={googleClientID} enabledProviders={ENABLED_PROVIDERS}>
        <ApplicationRoutes />
      </AuthenticationProvider>
    </BrowserRouter>
  );
}
