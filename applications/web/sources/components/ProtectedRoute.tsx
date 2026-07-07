import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useAuthentication } from '../features/authentication/use-authentication.ts';

/**
 * 인증 가드 — 미인증이면 `/sign/in`으로 replace. 세션은 store 생성 시 동기 복원되므로
 * 별도 isLoading 상태가 필요 없다 (개선 §2: 항상-false isLoading 제거).
 */
export const ProtectedRoute = ({ children }: { children: ReactNode }) => {
  const { isAuthenticated } = useAuthentication();
  if (!isAuthenticated) {
    return <Navigate to="/sign/in" replace />;
  }
  return <>{children}</>;
};
