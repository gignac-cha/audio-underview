import { Navigate } from 'react-router';
import { useAuthentication } from '../hooks/use-authentication.ts';
import type { ReactNode } from 'react';

interface ProtectedRouteProperties {
  children: ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProperties) {
  const { isAuthenticated, isLoading } = useAuthentication();

  if (isLoading) {
    return (
      <div className="loading-container">
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/sign/in" replace />;
  }

  return <>{children}</>;
}
