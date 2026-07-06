import {
  createOAuthState,
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
} from '@audio-underview/authentication-core';
import { getProviderStrategy } from '@audio-underview/authentication-providers';
import { authorizeQuerySchema, oauthProviderIDSchema } from '@audio-underview/schemas';
import {
  errorResponse,
  parseAllowedOrigins,
  type RequestContext,
} from '@audio-underview/worker-foundation';
import { parseAuthenticationEnvironment, type WorkerEnvironment } from '../environment.ts';
import { resolveProviderConfiguration } from '../provider-configurations.ts';

type Context = RequestContext<WorkerEnvironment>;

export const callbackURLFor = (requestURL: URL, provider: string): string =>
  `${requestURL.origin}/providers/${provider}/callback`;

/**
 * `GET /providers/:provider/authorize?redirect_uri=` (스펙 §5.6 + 개선):
 * - `redirect_uri`의 **origin이 ALLOWED_ORIGINS에 있어야 한다** — 레거시는
 *   임의 URI를 저장해 open-redirect 여지가 있었다.
 * - state 레코드(JSON, provider namespace, TTL 300s)가 nonce/PKCE verifier를 운반한다.
 */
export const handleAuthorize = async (context: Context): Promise<Response> => {
  const environment = parseAuthenticationEnvironment(context.environment);

  const providerParse = oauthProviderIDSchema.safeParse(context.parameters.provider);
  if (!providerParse.success) {
    return errorResponse('not_found', 'Unknown provider', 404, context.responseContext);
  }
  const provider = providerParse.data;

  const configuration = resolveProviderConfiguration(environment, provider);
  if (configuration === undefined) {
    return errorResponse('not_found', 'Provider is not enabled', 404, context.responseContext);
  }

  const queryParse = authorizeQuerySchema.safeParse({
    redirect_uri: context.url.searchParams.get('redirect_uri') ?? undefined,
  });
  if (!queryParse.success) {
    return errorResponse(
      'invalid_request',
      "Query parameter 'redirect_uri' is required and must be a valid URL",
      400,
      context.responseContext,
    );
  }
  const redirectURI = queryParse.data.redirect_uri;

  const allowedOrigins = parseAllowedOrigins(environment.ALLOWED_ORIGINS);
  const redirectOrigin = new URL(redirectURI).origin;
  if (!allowedOrigins.includes(redirectOrigin) && !allowedOrigins.includes('*')) {
    return errorResponse(
      'invalid_request',
      "Query parameter 'redirect_uri' origin is not allowed",
      400,
      context.responseContext,
    );
  }

  const strategy = getProviderStrategy(provider);
  const nonce = strategy.capabilities.usesNonce ? generateNonce() : undefined;
  const codeVerifier = strategy.capabilities.usesPKCE ? generateCodeVerifier() : undefined;
  const codeChallenge =
    codeVerifier === undefined ? undefined : await generateCodeChallenge(codeVerifier);

  const state = await createOAuthState(environment.OAUTH_STATE, {
    provider,
    redirectURI,
    ...(nonce !== undefined && { nonce }),
    ...(codeVerifier !== undefined && { codeVerifier }),
  });

  const authorizationURL = strategy.buildAuthorizationURL(configuration, {
    redirectURI: callbackURLFor(context.url, provider),
    state,
    nonce,
    codeChallenge,
  });

  return Response.redirect(authorizationURL.toString(), 302);
};
