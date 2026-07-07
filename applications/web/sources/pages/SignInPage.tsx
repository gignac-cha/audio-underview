import { Navigate } from 'react-router';
import { Button } from '../components/Button.tsx';
import { Spinner } from '../components/Spinner.tsx';
import { AuthShell } from '../features/authentication/components/AuthShell.tsx';
import { SignInButtons } from '../features/authentication/components/SignInButtons.tsx';
import { useAuthentication } from '../features/authentication/use-authentication.ts';
import { useEnabledProviders } from '../features/authentication/use-providers.ts';
import styles from './SignInPage.module.css';

export const SignInPage = () => {
  const { isAuthenticated } = useAuthentication();
  const { providers, isLoading, error, refetch } = useEnabledProviders();

  if (isAuthenticated) {
    return <Navigate to="/home" replace />;
  }

  return (
    <AuthShell title="Sign in" subtitle="Continue to the crawler & scheduler console.">
      {isLoading && (
        <div className={styles.centered}>
          <Spinner size={22} label="Loading providers…" />
        </div>
      )}
      {error !== undefined && (
        <div className={styles.centered}>
          <p className={styles.error}>Could not load sign-in options.</p>
          <Button
            variant="secondary"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {!isLoading && error === undefined && providers.length === 0 && (
        <p className={styles.error}>No sign-in providers are currently enabled.</p>
      )}
      {!isLoading && error === undefined && providers.length > 0 && (
        <SignInButtons providers={providers} />
      )}
    </AuthShell>
  );
};
