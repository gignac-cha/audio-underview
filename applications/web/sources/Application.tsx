import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { AuthenticationProvider, useAuthentication } from './contexts/AuthenticationContext.tsx';
import { SignInPage } from './pages/SignInPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { ProtectedRoute } from './components/ProtectedRoute.tsx';

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

export function Application() {
  return (
    <BrowserRouter>
      <AuthenticationProvider>
        <ApplicationRoutes />
      </AuthenticationProvider>
    </BrowserRouter>
  );
}
