import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import styled from '@emotion/styled';
import { getJWTExpiration, oauthUserSchema, type OAuthUser } from '@audio-underview/sign-provider';
import { createBrowserLogger } from '@audio-underview/logger';
import { useAuthentication } from '../hooks/use-authentication.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import { PageLayout } from '../design-system/components/PageLayout.tsx';
import { ActivityIndicator } from '../design-system/components/ActivityIndicator.tsx';
import { showNotice } from '../design-system/notice-store.ts';
import { color, fontSize, fontWeight, space, textStyle } from '../design-system/tokens.ts';

const callbackLogger = createBrowserLogger({
  defaultContext: {
    module: 'AuthenticationCallbackPage',
  },
});

const SERVICE_NAME = 'Audio Underview';
const SIGNING_IN_MESSAGE = '로그인하는 중입니다';
const FAILURE_TITLE = '로그인 실패';

/**
 * What went wrong, as a fixed code. This is the only thing the page logs about
 * a failure. The provider's own `error` code and `error_description` never
 * reach the log or the screen: anyone can put them in the URL.
 */
type FailureReason =
  | 'provider-error-access-denied'
  | 'provider-error-invalid-state'
  | 'provider-error-account-unavailable'
  | 'provider-error-other'
  | 'missing-user'
  | 'invalid-user'
  | 'missing-session-token'
  | 'invalid-session-token-expiration'
  | 'login-failed';

/** Notice text for each failure. Every one is fixed text; none is taken from the URL. */
const FAILURE_DESCRIPTIONS = {
  'provider-error-access-denied': '로그인을 취소했습니다.',
  'provider-error-invalid-state': '로그인 요청이 만료되었습니다. 다시 시도해주세요.',
  'provider-error-account-unavailable': '이 계정으로는 로그인할 수 없습니다.',
  'provider-error-other': '로그인에 실패했습니다. 잠시 후 다시 시도해주세요.',
  'missing-user': '로그인 정보를 확인하지 못했습니다.',
  'invalid-user': '로그인 정보를 확인하지 못했습니다.',
  'missing-session-token': '세션 토큰을 받지 못했습니다.',
  'invalid-session-token-expiration': '세션 토큰이 만료되었습니다.',
  'login-failed': '로그인 정보를 저장하지 못했습니다.',
} as const satisfies Record<FailureReason, string>;

type CallbackOutcome = { kind: 'signed-in' } | { kind: 'failed'; reason: FailureReason };

function failed(reason: FailureReason): CallbackOutcome {
  return { kind: 'failed', reason };
}

/**
 * Maps the OAuth worker's `error` code to one of the fixed failure reasons.
 * Any other code, the empty one included, is `provider-error-other`.
 */
function providerErrorReason(errorCode: string): FailureReason {
  switch (errorCode) {
    case 'access_denied':
      return 'provider-error-access-denied';
    case 'invalid_state':
      return 'provider-error-invalid-state';
    case 'account_unavailable':
      return 'provider-error-account-unavailable';
    default:
      return 'provider-error-other';
  }
}

function parseUser(userParameter: string): OAuthUser | undefined {
  try {
    const result = oauthUserSchema.safeParse(JSON.parse(decodeURIComponent(userParameter)));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads what the OAuth worker appended to the callback URL and signs in with
 * the service session token. Never calls the network. On failure it returns a
 * fixed reason code, which carries no token, user value, or text from the URL.
 */
function completeSignIn(
  parameters: URLSearchParams,
  loginWithProvider: AuthenticationContextValue['loginWithProvider'],
): CallbackOutcome {
  // `error_description` is never read: it is free text anyone can put in the
  // URL, and shown under the service's name it could pass for the service's
  // own words (CWE-451). The notice says only what the `error` code means.
  const errorCode = parameters.get('error');
  if (errorCode !== null) {
    return failed(providerErrorReason(errorCode));
  }

  const userParameter = parameters.get('user');
  if (userParameter === null) {
    return failed('missing-user');
  }

  const user = parseUser(userParameter);
  if (user === undefined) {
    return failed('invalid-user');
  }

  // Only the service session token signs a person in. `access_token` is the
  // provider's own token and never stands in for it.
  const sessionToken = parameters.get('session_token');
  if (sessionToken === null || sessionToken.length === 0) {
    return failed('missing-session-token');
  }

  const expiresAt = getJWTExpiration(sessionToken);
  const now = Date.now();
  if (expiresAt === undefined || expiresAt <= now) {
    return failed('invalid-session-token-expiration');
  }

  const result = loginWithProvider(user.provider, user, sessionToken, expiresAt - now);
  if (!result.success) {
    return failed('login-failed');
  }

  return { kind: 'signed-in' };
}

/**
 * Left-aligned on the same page edge as the sign-in screen's service name, and
 * vertically centered like it, so returning from the provider feels like the
 * same place. The service name in small type says which service is signing in.
 */
const Content = styled.div`
  display: grid;
  row-gap: ${space[3]};
  justify-items: start;
`;

const ServiceName = styled.p`
  ${textStyle.label};
  font-weight: ${fontWeight.semibold};
  color: ${color.inkSecondary};
`;

/**
 * The level meter stands on the text baseline and rises to the top of the
 * Hangul glyphs, so meter and words read as one line. Its size is taken from
 * this row's font size.
 */
const Status = styled.div`
  display: flex;
  align-items: baseline;
  gap: ${space[3]};
  font-size: ${fontSize.heading3};
`;

const Message = styled.h1`
  ${textStyle.heading3};
  color: ${color.ink};
`;

export function AuthenticationCallbackPage() {
  const navigate = useNavigate();
  const [searchParameters] = useSearchParams();
  const { loginWithProvider } = useAuthentication();
  const hasHandledCallbackRef = useRef(false);

  useEffect(() => {
    // React StrictMode runs this effect twice on mount and keeps the ref
    // between the runs, so the same callback is handled once.
    if (hasHandledCallbackRef.current) {
      return;
    }
    hasHandledCallbackRef.current = true;

    const outcome = completeSignIn(searchParameters, loginWithProvider);

    if (outcome.kind === 'signed-in') {
      navigate('/home', { replace: true });
      return;
    }

    callbackLogger.warn('Sign-in callback failed', { reason: outcome.reason }, { function: 'completeSignIn' });
    showNotice({ title: FAILURE_TITLE, description: FAILURE_DESCRIPTIONS[outcome.reason] });
    navigate('/sign/in', { replace: true });
  }, [searchParameters, loginWithProvider, navigate]);

  return (
    <PageLayout arrangement="vertically-centered">
      <Content>
        <ServiceName>{SERVICE_NAME}</ServiceName>
        <Status role="status">
          <ActivityIndicator size="text" />
          <Message>{SIGNING_IN_MESSAGE}</Message>
        </Status>
      </Content>
    </PageLayout>
  );
}
