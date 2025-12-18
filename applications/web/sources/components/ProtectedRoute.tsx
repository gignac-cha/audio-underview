import { Navigate } from 'react-router';
import { useSign } from '@audio-underview/sign-provider';
import type { ReactNode } from 'react';

interface ProtectedRouteProperties {
  children: ReactNode;
}

export function ProtectedRoute({ children }: ProtectedRouteProperties) {
  const { isAuthenticated, isLoading } = useSign();

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
