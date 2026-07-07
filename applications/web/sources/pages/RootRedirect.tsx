import { Navigate } from 'react-router';
import { useAuthentication } from '../features/authentication/use-authentication.ts';

/** `/` — 인증 여부에 따라 /home 또는 /sign/in으로 replace. */
export const RootRedirect = () => {
  const { isAuthenticated } = useAuthentication();
  return <Navigate to={isAuthenticated ? '/home' : '/sign/in'} replace />;
};
