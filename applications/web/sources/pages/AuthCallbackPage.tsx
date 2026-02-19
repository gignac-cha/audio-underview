import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useToast } from '../hooks/use-toast.ts';
import { createBrowserLogger } from '@audio-underview/logger';

const callbackLogger = createBrowserLogger({
  defaultContext: {
    module: 'AuthCallbackPage',
  },
});

/**
 * Schema for validating OAuth user data from callback
 */
const oAuthUserSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string().min(1),
  picture: z.url().optional(),
  provider: z.enum(['google', 'github', 'apple', 'microsoft', 'facebook', 'discord', 'kakao', 'naver', 'linkedin', 'x']),
  uuid: z.uuid().optional(),
});

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const { loginWithProvider } = useAuthentication();
  const { showError } = useToast();
  const [isProcessing, setIsProcessing] = useState(true);
  const processingRef = useRef(false);

  useEffect(() => {
    const processCallback = async () => {
      // Prevent re-entrancy
      if (processingRef.current) {
        return;
      }
      processingRef.current = true;
      setIsProcessing(true);

      callbackLogger.info('Processing OAuth callback', {
        hasUser: searchParameters.has('user'),
        hasAccessToken: searchParameters.has('access_token'),
        hasError: searchParameters.has('error'),
      }, { function: 'processCallback' });

      try {
        // Check for error from OAuth provider
        const error = searchParameters.get('error');
        if (error) {
          const errorDescription = searchParameters.get('error_description') ?? 'Authentication failed';
          callbackLogger.error('OAuth provider returned error', new Error(error), {
            function: 'processCallback',
            metadata: { error, errorDescription },
          });
          showError('로그인 실패', errorDescription);
          navigate('/sign/in', { replace: true });
          return;
        }

        // Get user data and access token
        const userParameter = searchParameters.get('user');
        const accessToken = searchParameters.get('access_token');

        if (!userParameter || !accessToken) {
          callbackLogger.error('Missing authentication data in callback', undefined, {
            function: 'processCallback',
            metadata: { hasUser: !!userParameter, hasAccessToken: !!accessToken },
          });
          showError('로그인 실패', 'Missing authentication data');
          navigate('/sign/in', { replace: true });
          return;
        }

        // Parse and validate user data with Zod schema
        const parsedUserData = JSON.parse(decodeURIComponent(userParameter));
        const validationResult = oAuthUserSchema.safeParse(parsedUserData);

        if (!validationResult.success) {
          const errors = validationResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
          callbackLogger.error('User data validation failed', new Error(errors), {
            function: 'processCallback',
            metadata: { validationErrors: validationResult.error.issues },
          });
          throw new Error(`Invalid user data: ${errors}`);
        }

        const user = validationResult.data;

        callbackLogger.info('OAuth callback data validated successfully', {
          provider: user.provider,
          userID: user.id,
          email: user.email,
        }, { function: 'processCallback' });

        // Exchange OAuth access token for a self-issued JWT
        const crawlerManagerURL = import.meta.env.VITE_CRAWLER_MANAGER_WORKER_URL;
        if (!crawlerManagerURL) {
          throw new Error('Crawler manager worker URL is not configured');
        }

        const tokenResponse = await fetch(`${crawlerManagerURL}/auth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: user.provider, access_token: accessToken }),
          signal: AbortSignal.timeout(10_000),
        });

        if (!tokenResponse.ok) {
          const errorBody = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
          const errorDescription = String(errorBody.error_description ?? errorBody.error ?? 'Token exchange failed');
          callbackLogger.error('Token exchange failed', new Error(errorDescription), {
            function: 'processCallback',
            metadata: { provider: user.provider, status: tokenResponse.status },
          });
          throw new Error(errorDescription);
        }

        const tokenData = await tokenResponse.json() as { token: string; expires_in: number };

        // Login with the JWT (not the OAuth access token)
        const result = loginWithProvider(user.provider, user, tokenData.token, tokenData.expires_in * 1000);

        if (result.success) {
          callbackLogger.info('OAuth login successful, redirecting to home', {
            provider: user.provider,
            userID: user.id,
          }, { function: 'processCallback' });
          navigate('/home', { replace: true });
        } else {
          callbackLogger.error('Failed to save authentication', new Error(result.error ?? 'Unknown error'), {
            function: 'processCallback',
            metadata: { provider: user.provider },
          });
          showError('로그인 실패', result.error ?? 'Failed to save authentication');
          navigate('/sign/in', { replace: true });
        }
      } catch (error) {
        callbackLogger.error('Failed to process OAuth callback', error, {
          function: 'processCallback',
        });
        showError('로그인 실패', 'Invalid authentication response');
        navigate('/sign/in', { replace: true });
      } finally {
        setIsProcessing(false);
        processingRef.current = false;
      }
    };

    processCallback();

    return () => {
      processingRef.current = false;
    };
  }, [searchParameters, loginWithProvider, navigate, showError]);

  if (isProcessing) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        <div
          style={{
            width: '40px',
            height: '40px',
            border: '3px solid #e2e8f0',
            borderTop: '3px solid #3b82f6',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
        <p style={{ color: '#64748b' }}>로그인 처리 중...</p>
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  return null;
}
