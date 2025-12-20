import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { z } from 'zod';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

/**
 * Schema for validating OAuth user data from callback
 */
const oAuthUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  picture: z.string().url().optional(),
  provider: z.enum(['google', 'github', 'apple', 'microsoft', 'facebook', 'discord', 'kakao', 'naver', 'linkedin', 'x']),
});

export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const { loginWithProvider } = useAuthentication();
  const { showError } = useToast();
  const [isProcessing, setIsProcessing] = useState(true);
  const processingRef = useRef(false);

  useEffect(() => {
    const processCallback = () => {
      // Prevent re-entrancy
      if (processingRef.current) {
        return;
      }
      processingRef.current = true;
      setIsProcessing(true);

      try {
        // Check for error from OAuth provider
        const error = searchParameters.get('error');
        if (error) {
          const errorDescription = searchParameters.get('error_description') ?? 'Authentication failed';
          showError('로그인 실패', errorDescription);
          navigate('/sign/in', { replace: true });
          return;
        }

        // Get user data and access token
        const userParameter = searchParameters.get('user');
        const accessToken = searchParameters.get('access_token');

        if (!userParameter || !accessToken) {
          showError('로그인 실패', 'Missing authentication data');
          navigate('/sign/in', { replace: true });
          return;
        }

        // Parse and validate user data with Zod schema
        const parsedUserData = JSON.parse(decodeURIComponent(userParameter));
        const validationResult = oAuthUserSchema.safeParse(parsedUserData);

        if (!validationResult.success) {
          const errors = validationResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
          console.error('User data validation failed:', errors);
          throw new Error(`Invalid user data: ${errors}`);
        }

        const user = validationResult.data;

        // Login with the provider
        const result = loginWithProvider(user.provider, user, accessToken);

        if (result.success) {
          navigate('/home', { replace: true });
        } else {
          showError('로그인 실패', result.error ?? 'Failed to save authentication');
          navigate('/sign/in', { replace: true });
        }
      } catch (error) {
        console.error('Failed to parse user data:', error);
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
