import {
  consumeOAuthState,
  createAuthorizationCode,
  OAuthFlowError,
} from '@audio-underview/authentication-core';
import { getProviderStrategy } from '@audio-underview/authentication-providers';
import {
  createDatabaseClient,
  handleSocialLogin,
  type SocialLoginInput,
  type SocialLoginResult,
} from '@audio-underview/database-connector';
import { oauthProviderIDSchema } from '@audio-underview/schemas';
import { errorResponse, type RequestContext } from '@audio-underview/worker-foundation';
import {
  parseAuthenticationEnvironment,
  type AuthenticationEnvironment,
  type WorkerEnvironment,
} from '../environment.ts';
import { resolveProviderConfiguration } from '../provider-configurations.ts';
import { callbackURLFor } from './authorize.ts';

type Context = RequestContext<WorkerEnvironment>;

export type SocialLoginFunction = (input: SocialLoginInput) => Promise<SocialLoginResult>;

export interface CallbackDependencies {
  fetchImplementation?: typeof fetch;
  /** 테스트 주입용 — 기본은 Supabase RPC 기반 구현 */
  socialLogin?: SocialLoginFunction;
}

/**
 * callback 파라미터 — GET query 또는 apple form_post(POST form body) 양쪽 지원.
 */
const readCallbackParameters = async (
  context: Context,
): Promise<Record<string, string>> => {
  const parameters: Record<string, string> = {};
  for (const [name, value] of context.url.searchParams) {
    parameters[name] = value;
  }
  if (context.request.method === 'POST') {
    const contentType = context.request.headers.get('Content-Type') ?? '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const form = await context.request.formData();
      for (const [name, value] of form) {
        if (typeof value === 'string') {
          parameters[name] = value;
        }
      }
    }
  }
  return parameters;
};

const redirectWithError = (
  frontendBase: string,
  error: string,
  errorDescription: string,
): Response => {
  const url = new URL(frontendBase);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', errorDescription);
  return Response.redirect(url.toString(), 302);
};

/**
 * `GET|POST /providers/:provider/callback` (스펙 §5.6 + §4.1 신규 플로우):
 * state 검증 → token 교환(+PKCE) → 사용자 정규화(id_token은 JWKS+nonce 검증)
 * → social login(트랜잭션 RPC, **10개 provider 전부**) → 일회용 code 발급
 * → 302 `{redirectURI}?code=...&provider=...` — redirect에 토큰/사용자 정보 없음.
 */
export const handleCallback = async (
  context: Context,
  dependencies: CallbackDependencies = {},
): Promise<Response> => {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const environment: AuthenticationEnvironment = parseAuthenticationEnvironment(
    context.environment,
  );

  const providerParse = oauthProviderIDSchema.safeParse(context.parameters.provider);
  if (!providerParse.success) {
    return errorResponse('not_found', 'Unknown provider', 404, context.responseContext);
  }
  const provider = providerParse.data;

  const configuration = resolveProviderConfiguration(environment, provider);
  if (configuration === undefined) {
    return errorResponse('not_found', 'Provider is not enabled', 404, context.responseContext);
  }

  const parameters = await readCallbackParameters(context);
  const fallbackRedirect = `${environment.FRONTEND_URL.replace(/\/$/, '')}/authentication/callback`;

  // provider가 에러를 돌려준 경우 (사용자 거부 등)
  if (parameters.error !== undefined) {
    return redirectWithError(
      fallbackRedirect,
      parameters.error,
      parameters.error_description ?? 'The provider returned an error',
    );
  }
  const code = parameters.code;
  const state = parameters.state;
  if (code === undefined || state === undefined) {
    return redirectWithError(
      fallbackRedirect,
      'invalid_request',
      'Missing code or state parameter',
    );
  }

  const stateRecord = await consumeOAuthState(environment.OAUTH_STATE, provider, state);
  if (stateRecord === undefined) {
    return redirectWithError(fallbackRedirect, 'invalid_state', 'State is invalid or expired');
  }

  try {
    const strategy = getProviderStrategy(provider);
    const tokens = await strategy.exchangeCode(
      configuration,
      {
        code,
        redirectURI: callbackURLFor(context.url, provider),
        ...(stateRecord.codeVerifier !== undefined && { codeVerifier: stateRecord.codeVerifier }),
      },
      fetchImplementation,
    );

    const user = await strategy.fetchUser(configuration, tokens, {
      fetchImplementation,
      ...(stateRecord.nonce !== undefined && { expectedNonce: stateRecord.nonce }),
      ...(parameters.user !== undefined && { appleUserPayload: parameters.user }),
    });

    // 10개 provider 전부 계정 연결 (레거시: google/github만 — 스펙 §10.1 해소)
    const socialLogin: SocialLoginFunction =
      dependencies.socialLogin ??
      ((input) =>
        handleSocialLogin(
          createDatabaseClient({
            supabaseURL: environment.SUPABASE_URL,
            supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
          }),
          input,
        ));
    const login = await socialLogin({ provider, identifier: user.id });

    const authorizationCode = await createAuthorizationCode(environment.OAUTH_STATE, {
      user: { ...user, uuid: login.userUUID },
    });

    const redirect = new URL(stateRecord.redirectURI);
    redirect.searchParams.set('code', authorizationCode);
    redirect.searchParams.set('provider', provider);
    return Response.redirect(redirect.toString(), 302);
  } catch (error) {
    context.logger.error('OAuth callback failed', error, {
      function: 'handleCallback',
      metadata: { provider },
    });
    if (error instanceof OAuthFlowError) {
      return redirectWithError(stateRecord.redirectURI, error.errorCode, error.message);
    }
    return redirectWithError(
      stateRecord.redirectURI,
      'server_error',
      'Authentication failed unexpectedly',
    );
  }
};
