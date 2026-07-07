import { Spinner } from '../components/Spinner.tsx';
import { AuthShell } from '../features/authentication/components/AuthShell.tsx';
import { useAuthenticationCallback } from '../features/authentication/use-authentication-callback.ts';

/** OAuth 콜백 처리 화면 — 토큰 교환 중 스피너, 실패 시 use-hook이 /sign/in으로 리다이렉트. */
export const AuthenticationCallbackPage = () => {
  const status = useAuthenticationCallback();

  return (
    <AuthShell title="Signing in" subtitle="Completing your sign-in…">
      {status === 'processing' ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
          <Spinner size={22} label="Signing you in…" />
        </div>
      ) : (
        <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>
          Redirecting to sign-in…
        </p>
      )}
    </AuthShell>
  );
};
