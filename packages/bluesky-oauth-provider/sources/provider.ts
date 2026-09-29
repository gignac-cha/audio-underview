import { z } from 'zod';
import type {
  OAuthProvider,
  OAuthAuthorizationParameters,
  OAuthCallbackParameters,
  OAuthUser,
} from '@audio-underview/sign-provider';

import {
  BLUESKY_PROVIDER_ID,
  BLUESKY_DISPLAY_NAME,
  BLUESKY_AUTHORIZATION_ENDPOINT,
  BLUESKY_TOKEN_ENDPOINT,
  BLUESKY_PLC_DIRECTORY_URL,
  BLUESKY_CLIENT_METADATA_PATH,
  BLUESKY_JWKS_PATH,
  BLUESKY_CALLBACK_PATH,
  BLUESKY_DEFAULT_SCOPES,
  BLUESKY_CLIENT_NAME,
  BLUESKY_SIGNING_ALGORITHM,
} from './configuration.ts';

function parseWithSchema<Schema extends z.ZodType>(
  schema: Schema,
  data: unknown,
  label: string
): z.infer<Schema> {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Bluesky ${label}: ${errors}`);
  }

  return result.data;
}

/**
 * `com.atproto.server.getSession` response schema
 * `email` is only present when the session was granted `transition:email`.
 */
export const blueskySessionResponseSchema = z.object({
  did: z.string().startsWith('did:'),
  handle: z.string().min(1),
  email: z.string().email().optional(),
  emailConfirmed: z.boolean().optional(),
  emailAuthFactor: z.boolean().optional(),
  active: z.boolean().optional(),
  status: z.string().optional(),
});

export type BlueskySessionResponse = z.infer<typeof blueskySessionResponseSchema>;

/**
 * Parse Bluesky getSession response
 */
export function parseBlueskySessionResponse(data: unknown): BlueskySessionResponse {
  return parseWithSchema(blueskySessionResponseSchema, data, 'session response');
}

/**
 * `com.atproto.identity.resolveHandle` response schema
 */
export const blueskyResolveHandleResponseSchema = z.object({
  did: z.string().startsWith('did:'),
});

export type BlueskyResolveHandleResponse = z.infer<typeof blueskyResolveHandleResponseSchema>;

export function parseBlueskyResolveHandleResponse(data: unknown): BlueskyResolveHandleResponse {
  return parseWithSchema(blueskyResolveHandleResponseSchema, data, 'resolveHandle response');
}

/**
 * DID document schema — only the fields the login flow reads.
 */
export const blueskyDIDDocumentSchema = z.object({
  id: z.string().startsWith('did:'),
  alsoKnownAs: z.array(z.string()).optional(),
  service: z
    .array(
      z.object({
        id: z.string(),
        type: z.unknown(),
        serviceEndpoint: z.unknown(),
      })
    )
    .optional(),
});

export type BlueskyDIDDocument = z.infer<typeof blueskyDIDDocumentSchema>;

export function parseBlueskyDIDDocument(data: unknown): BlueskyDIDDocument {
  return parseWithSchema(blueskyDIDDocumentSchema, data, 'DID document');
}

/**
 * OAuth protected resource metadata (the PDS) schema
 */
export const blueskyProtectedResourceMetadataSchema = z.object({
  authorization_servers: z.array(z.string()).min(1),
});

export type BlueskyProtectedResourceMetadata = z.infer<typeof blueskyProtectedResourceMetadataSchema>;

export function parseBlueskyProtectedResourceMetadata(data: unknown): BlueskyProtectedResourceMetadata {
  return parseWithSchema(blueskyProtectedResourceMetadataSchema, data, 'protected resource metadata');
}

/**
 * OAuth authorization server metadata schema
 */
export const blueskyAuthorizationServerMetadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  pushed_authorization_request_endpoint: z.string().url(),
  require_pushed_authorization_requests: z.boolean().optional(),
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_signing_alg_values_supported: z.array(z.string()).optional(),
  dpop_signing_alg_values_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

export type BlueskyAuthorizationServerMetadata = z.infer<typeof blueskyAuthorizationServerMetadataSchema>;

export function parseBlueskyAuthorizationServerMetadata(data: unknown): BlueskyAuthorizationServerMetadata {
  return parseWithSchema(blueskyAuthorizationServerMetadataSchema, data, 'authorization server metadata');
}

/**
 * Pushed authorization request (PAR) response schema
 */
export const blueskyPushedAuthorizationResponseSchema = z.object({
  request_uri: z.string().min(1),
  expires_in: z.number().optional(),
});

export type BlueskyPushedAuthorizationResponse = z.infer<typeof blueskyPushedAuthorizationResponseSchema>;

export function parseBlueskyPushedAuthorizationResponse(data: unknown): BlueskyPushedAuthorizationResponse {
  return parseWithSchema(blueskyPushedAuthorizationResponseSchema, data, 'pushed authorization response');
}

/**
 * Token response schema
 * The atproto profile always returns the account DID in `sub` and the granted
 * scopes in `scope`.
 */
export const blueskyTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  sub: z.string().startsWith('did:'),
  scope: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

export type BlueskyTokenResponse = z.infer<typeof blueskyTokenResponseSchema>;

export function parseBlueskyTokenResponse(data: unknown): BlueskyTokenResponse {
  return parseWithSchema(blueskyTokenResponseSchema, data, 'token response');
}

/**
 * Whether a granted scope string carries `atproto` — sessions without it must
 * be rejected.
 */
export function blueskyScopeIncludesAtproto(scope: string): boolean {
  return scope.split(' ').includes('atproto');
}

const HANDLE_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Top-level domains the atproto handle specification refuses to resolve. */
const DISALLOWED_HANDLE_TOP_LEVEL_DOMAINS = new Set([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
]);

/**
 * Normalizes user input into a handle (`@Alice.bsky.social` → `alice.bsky.social`).
 *
 * @returns The normalized handle, or undefined when it is not a valid handle
 */
export function normalizeBlueskyHandle(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }

  const handle = input.trim().replace(/^@/, '').toLowerCase();

  if (handle.length === 0 || handle.length > 253 || !HANDLE_PATTERN.test(handle)) {
    return undefined;
  }

  const topLevelDomain = handle.slice(handle.lastIndexOf('.') + 1);
  if (DISALLOWED_HANDLE_TOP_LEVEL_DOMAINS.has(topLevelDomain)) {
    return undefined;
  }

  return handle;
}

const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const WEB_DID_PATTERN = /^did:web:([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Where a DID document lives. atproto blesses `did:plc` and hostname-level
 * `did:web`; anything else is refused.
 *
 * @returns The DID document URL, or undefined for an unsupported DID
 */
export function createBlueskyDIDDocumentURL(did: string): string | undefined {
  if (PLC_DID_PATTERN.test(did)) {
    return `${BLUESKY_PLC_DIRECTORY_URL}/${did}`;
  }

  if (WEB_DID_PATTERN.test(did)) {
    return `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  }

  return undefined;
}

/**
 * Reduces an https URL to its origin, refusing anything with credentials, a
 * path, a query or a fragment — the shape atproto requires of PDS and
 * authorization server locations.
 */
export function parseBlueskyServerOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The PDS the DID document declares (`#atproto_pds` service).
 */
export function findBlueskyPDSURL(document: BlueskyDIDDocument): string | undefined {
  const service = document.service?.find(
    (entry) =>
      (entry.id === '#atproto_pds' || entry.id === `${document.id}#atproto_pds`) &&
      entry.type === 'AtprotoPersonalDataServer'
  );

  return service ? parseBlueskyServerOrigin(service.serviceEndpoint) : undefined;
}

/**
 * Bidirectional handle verification: the DID document's primary handle (its
 * first `at://` alias) must be the handle the login started with.
 */
export function blueskyDIDDocumentClaimsHandle(document: BlueskyDIDDocument, handle: string): boolean {
  const primaryAlias = document.alsoKnownAs?.find((alias) => alias.startsWith('at://'));
  return primaryAlias !== undefined && primaryAlias.slice('at://'.length).toLowerCase() === handle.toLowerCase();
}

/**
 * Client ID metadata document the worker publishes at
 * `${origin}/oauth-client-metadata.json`. The URL of that document is the
 * client_id; there is no client secret.
 */
export interface BlueskyClientMetadata {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  scope: string;
  token_endpoint_auth_method: 'private_key_jwt';
  token_endpoint_auth_signing_alg: string;
  dpop_bound_access_tokens: true;
  application_type: 'web';
  jwks_uri: string;
}

export function createBlueskyClientMetadata(origin: string): BlueskyClientMetadata {
  return {
    client_id: `${origin}${BLUESKY_CLIENT_METADATA_PATH}`,
    client_name: BLUESKY_CLIENT_NAME,
    redirect_uris: [`${origin}${BLUESKY_CALLBACK_PATH}`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: BLUESKY_DEFAULT_SCOPES.join(' '),
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: BLUESKY_SIGNING_ALGORITHM,
    dpop_bound_access_tokens: true,
    application_type: 'web',
    jwks_uri: `${origin}${BLUESKY_JWKS_PATH}`,
  };
}

/**
 * Callback parameters, plus the `iss` the authorization server sends with
 * every response (RFC 9207).
 */
export interface BlueskyCallbackParameters extends OAuthCallbackParameters {
  issuer?: string;
}

export function parseBlueskyCallbackParameters(url: string | URL): BlueskyCallbackParameters {
  const parsedURL = typeof url === 'string' ? new URL(url) : url;
  const queryParameters = parsedURL.searchParams;

  return {
    code: queryParameters.get('code') ?? undefined,
    state: queryParameters.get('state') ?? undefined,
    error: queryParameters.get('error') ?? undefined,
    errorDescription: queryParameters.get('error_description') ?? undefined,
    issuer: queryParameters.get('iss') ?? undefined,
  };
}

/**
 * After a pushed authorization request, the browser is sent to the
 * authorization endpoint with only `client_id` and `request_uri`; everything
 * else already travelled in the PAR body.
 */
function buildPushedAuthorizationURL(
  authorizationEndpoint: string,
  clientID: string,
  requestURI: string
): string {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('client_id', clientID);
  url.searchParams.set('request_uri', requestURI);
  return url.toString();
}

/**
 * Bluesky OAuth provider implementation
 */
export const blueskyOAuthProvider: OAuthProvider = {
  providerID: BLUESKY_PROVIDER_ID,
  displayName: BLUESKY_DISPLAY_NAME,
  authorizationEndpoint: BLUESKY_AUTHORIZATION_ENDPOINT,
  tokenEndpoint: BLUESKY_TOKEN_ENDPOINT,
  // No userInfoEndpoint: getSession lives on the account's own PDS
  // (BLUESKY_USER_INFO_PATH), which differs per account.

  /**
   * Expects `additionalParameters.request_uri` (from the pushed authorization
   * request) and optionally `additionalParameters.authorization_endpoint`
   * (from the account's authorization server metadata; defaults to
   * bsky.social). Scopes, state, PKCE and the redirect URI are not repeated
   * here because they were pushed with the request.
   */
  buildAuthorizationURL(parameters: OAuthAuthorizationParameters): string {
    const requestURI = parameters.additionalParameters?.request_uri;

    if (!requestURI) {
      throw new Error('Bluesky authorization requires the request_uri returned by a pushed authorization request');
    }

    return buildPushedAuthorizationURL(
      parameters.additionalParameters?.authorization_endpoint ?? BLUESKY_AUTHORIZATION_ENDPOINT,
      parameters.clientID,
      requestURI
    );
  },

  parseCallbackParameters(url: string | URL): OAuthCallbackParameters {
    return parseBlueskyCallbackParameters(url);
  },

  parseUserData(data: Record<string, unknown>): OAuthUser {
    const session = parseBlueskySessionResponse(data);

    // The DID is the permanent account identifier; the handle can change and
    // serves as the display name. Bluesky has no profile picture here, and the
    // email is only passed on when the server actually returned one.
    return {
      id: session.did,
      name: session.handle,
      provider: BLUESKY_PROVIDER_ID,
      ...(session.email ? { email: session.email } : {}),
    };
  },
};

/**
 * Create the Bluesky authorization URL for a completed pushed authorization
 * request
 */
export function createBlueskyAuthorizationURL(
  clientID: string,
  requestURI: string,
  options?: {
    authorizationEndpoint?: string;
  }
): string {
  return buildPushedAuthorizationURL(
    options?.authorizationEndpoint ?? BLUESKY_AUTHORIZATION_ENDPOINT,
    clientID,
    requestURI
  );
}

/**
 * Parse Bluesky user data from a getSession response
 */
export function parseBlueskyUserFromResponse(response: Record<string, unknown>): OAuthUser {
  return blueskyOAuthProvider.parseUserData(response);
}
