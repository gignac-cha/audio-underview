import { tokenResponseSchema } from '@audio-underview/schemas';
import { useSetAtom } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toErrorMessage } from '../../api/errors.ts';
import { useApiClient } from '../../api/use-api-client.tsx';
import { sessionAtom } from '../../state/session.ts';
import { useToasts } from '../../state/toasts.ts';

export type CallbackStatus = 'processing' | 'error';

/**
 * OAuth 콜백 처리 (신규 authorization code 중계 방식, 아키텍처 §4.1):
 * `?code` → `POST {AUTH}/tokens {grant_type:'authorization_code', code}` →
 * `{access_token, refresh_token, expires_in, user}` 세션 저장 → `/home`.
 * 모든 실패는 error toast + `/sign/in` replace. re-entrancy는 ref로 차단.
 */
export const useAuthenticationCallback = (): CallbackStatus => {
  const client = useApiClient();
  const setSession = useSetAtom(sessionAtom);
  const navigate = useNavigate();
  const { showError } = useToasts();
  const [searchParameters] = useSearchParams();
  const processingRef = useRef(false);
  const [status, setStatus] = useState<CallbackStatus>('processing');

  useEffect(() => {
    if (processingRef.current) {
      return;
    }
    processingRef.current = true;

    const failToSignIn = (message: string) => {
      showError('Sign-in failed', message);
      setStatus('error');
      void navigate('/sign/in', { replace: true });
    };

    const errorParameter = searchParameters.get('error');
    if (errorParameter !== null) {
      failToSignIn(searchParameters.get('error_description') ?? errorParameter);
      return;
    }

    const code = searchParameters.get('code');
    if (code === null || code.length === 0) {
      failToSignIn('The sign-in response was missing an authorization code.');
      return;
    }

    const exchange = async () => {
      try {
        const response = await client.request('VITE_AUTHENTICATION_WORKER_URL', '/tokens', {
          method: 'POST',
          authenticated: false,
          body: { grant_type: 'authorization_code', code },
          schema: tokenResponseSchema,
          timeoutMilliseconds: 10_000,
        });
        setSession({
          accessToken: response.access_token,
          refreshToken: response.refresh_token,
          expiresAt: Date.now() + response.expires_in * 1000,
          user: response.user,
        });
        void navigate('/home', { replace: true });
      } catch (error) {
        failToSignIn(toErrorMessage(error));
      }
    };

    void exchange();
  }, [client, navigate, searchParameters, setSession, showError]);

  return status;
};
