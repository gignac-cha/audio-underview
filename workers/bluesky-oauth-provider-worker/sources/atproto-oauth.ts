/**
 * AT Protocol OAuth client mechanics for the Bluesky worker: identity and
 * server discovery, DPoP proofs, `private_key_jwt` client assertions, and the
 * three DPoP-bound requests (PAR, token, getSession).
 *
 * Written against WebCrypto (ECDSA P-256 / ES256) directly. The
 * `@atproto/oauth-client` package does not run in the Workers runtime — its
 * handle resolver calls fetch with `redirect: 'error'`, which workerd refuses —
 * and its own state store cannot hold the `generateState()` keyed state the
 * shared worker contract requires.
 *
 * Specification: https://atproto.com/specs/oauth
 */
import {
  BLUESKY_HANDLE_RESOLUTION_ENDPOINT,
  BLUESKY_PROTECTED_RESOURCE_METADATA_PATH,
  BLUESKY_AUTHORIZATION_SERVER_METADATA_PATH,
  BLUESKY_USER_INFO_PATH,
  BLUESKY_SIGNING_ALGORITHM,
  BLUESKY_CLIENT_ASSERTION_TYPE,
  blueskyDIDDocumentClaimsHandle,
  blueskyScopeIncludesAtproto,
  createBlueskyDIDDocumentURL,
  findBlueskyPDSURL,
  parseBlueskyAuthorizationServerMetadata,
  parseBlueskyDIDDocument,
  parseBlueskyProtectedResourceMetadata,
  parseBlueskyPushedAuthorizationResponse,
  parseBlueskyResolveHandleResponse,
  parseBlueskyServerOrigin,
  parseBlueskySessionResponse,
  parseBlueskyTokenResponse,
  type BlueskyAuthorizationServerMetadata,
  type BlueskySessionResponse,
  type BlueskyTokenResponse,
} from '@audio-underview/bluesky-oauth-provider';

/**
 * A step of the flow failed for a reason the user or operator can act on.
 * `code` becomes the `error` query parameter sent to the frontend, and the
 * message its `error_description`, so neither may carry secrets.
 */
export class BlueskyFlowError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BlueskyFlowError';
    this.code = code;
    this.details = details;
  }
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ES256_SIGNATURE = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Lifetime of a client assertion; servers accept ones younger than a minute. */
const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;

const textEncoder = new TextEncoder();

function encodeBase64URL(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeBase64URLJSON(value: unknown): string {
  return encodeBase64URL(textEncoder.encode(JSON.stringify(value)));
}

function currentEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Signs a compact JWS with ES256. WebCrypto's ECDSA output is already the
 * raw `r || s` form JWS expects, so no DER conversion is needed.
 */
async function signES256Token(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey
): Promise<string> {
  const signingInput = `${encodeBase64URLJSON(header)}.${encodeBase64URLJSON(payload)}`;
  const signature = await crypto.subtle.sign(ES256_SIGNATURE, privateKey, textEncoder.encode(signingInput));
  return `${signingInput}.${encodeBase64URL(new Uint8Array(signature))}`;
}

export interface PublicECJWK {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** What the state keeps so the callback can keep using the login's DPoP key. */
export interface DPoPPrivateJWK extends PublicECJWK {
  d: string;
}

export interface ClientSigningKey {
  keyID: string;
  privateKey: CryptoKey;
  /** The JWK published at `/jwks.json`: the private key minus `d`. */
  publicJWK: PublicECJWK & { kid: string; alg: string; use: 'sig' };
}

export interface DPoPKey {
  privateKey: CryptoKey;
  publicJWK: PublicECJWK;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Whether a value is a P-256 private JWK. `kid` is checked separately because
 * only the client key needs one.
 */
export function isDPoPPrivateJWK(value: unknown): value is DPoPPrivateJWK {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.kty === 'EC' &&
    candidate.crv === 'P-256' &&
    isNonEmptyString(candidate.x) &&
    isNonEmptyString(candidate.y) &&
    isNonEmptyString(candidate.d)
  );
}

async function importPrivateKey(jwk: DPoPPrivateJWK): Promise<CryptoKey> {
  // Only the key material is handed to WebCrypto: a stray `key_ops`, `use`
  // or `ext` member would otherwise make the import throw.
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    ECDSA_P256,
    false,
    ['sign']
  );
}

/**
 * Loads `BLUESKY_CLIENT_PRIVATE_JWK` — the ES256 key whose public half the
 * client metadata advertises and which signs every client assertion.
 */
export async function importClientSigningKey(serializedJWK: string | undefined): Promise<ClientSigningKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedJWK ?? '');
  } catch {
    throw new BlueskyFlowError('client_key_unavailable', 'Bluesky client key is not configured');
  }

  const kid = (parsed as { kid?: unknown } | null)?.kid;
  const alg = (parsed as { alg?: unknown } | null)?.alg;

  if (!isDPoPPrivateJWK(parsed) || !isNonEmptyString(kid) || (alg !== undefined && alg !== BLUESKY_SIGNING_ALGORITHM)) {
    throw new BlueskyFlowError(
      'client_key_unavailable',
      'Bluesky client key must be an ES256 (P-256) private JWK with a kid'
    );
  }

  let privateKey: CryptoKey;
  try {
    privateKey = await importPrivateKey(parsed);
  } catch {
    throw new BlueskyFlowError('client_key_unavailable', 'Bluesky client key could not be imported');
  }

  return {
    keyID: kid,
    privateKey,
    publicJWK: {
      kty: 'EC',
      crv: 'P-256',
      x: parsed.x,
      y: parsed.y,
      kid,
      alg: BLUESKY_SIGNING_ALGORITHM,
      use: 'sig',
    },
  };
}

/**
 * A fresh DPoP key for one login. The private JWK goes into the state so the
 * callback can prove possession of the same key at the token endpoint.
 */
export async function generateDPoPKey(): Promise<{ key: DPoPKey; privateJWK: DPoPPrivateJWK }> {
  const keyPair = (await crypto.subtle.generateKey(ECDSA_P256, true, ['sign', 'verify'])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as JsonWebKey;

  if (!isDPoPPrivateJWK(exported)) {
    throw new Error('Generated DPoP key did not export as a P-256 JWK');
  }

  const privateJWK: DPoPPrivateJWK = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, d: exported.d };

  return {
    key: { privateKey: keyPair.privateKey, publicJWK: { kty: 'EC', crv: 'P-256', x: privateJWK.x, y: privateJWK.y } },
    privateJWK,
  };
}

export async function restoreDPoPKey(privateJWK: DPoPPrivateJWK): Promise<DPoPKey> {
  return {
    privateKey: await importPrivateKey(privateJWK),
    publicJWK: { kty: 'EC', crv: 'P-256', x: privateJWK.x, y: privateJWK.y },
  };
}

async function hashAccessToken(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(accessToken));
  return encodeBase64URL(new Uint8Array(digest));
}

/**
 * DPoP proof JWT (RFC 9449). `htu` is the target URI without query and
 * fragment; `ath` binds a resource request to its access token.
 */
export async function createDPoPProof(
  key: DPoPKey,
  options: { method: string; url: string; nonce?: string; accessToken?: string }
): Promise<string> {
  const target = new URL(options.url);
  target.search = '';
  target.hash = '';

  const payload: Record<string, unknown> = {
    jti: crypto.randomUUID(),
    htm: options.method,
    htu: target.toString(),
    iat: currentEpochSeconds(),
  };

  if (options.nonce) {
    payload.nonce = options.nonce;
  }

  if (options.accessToken) {
    payload.ath = await hashAccessToken(options.accessToken);
  }

  return signES256Token(
    { typ: 'dpop+jwt', alg: BLUESKY_SIGNING_ALGORITHM, jwk: key.publicJWK },
    payload,
    key.privateKey
  );
}

/**
 * `private_key_jwt` client assertion (RFC 7523). The audience is the
 * authorization server's issuer, and `jti` is fresh for every request.
 */
export async function createClientAssertion(
  clientKey: ClientSigningKey,
  clientID: string,
  issuer: string
): Promise<string> {
  const issuedAt = currentEpochSeconds();

  return signES256Token(
    { alg: BLUESKY_SIGNING_ALGORITHM, kid: clientKey.keyID },
    {
      iss: clientID,
      sub: clientID,
      aud: issuer,
      jti: crypto.randomUUID(),
      iat: issuedAt,
      exp: issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS,
    },
    clientKey.privateKey
  );
}

/**
 * Whether the server refused the request only for want of its current DPoP
 * nonce: 400 `{"error":"use_dpop_nonce"}` from an authorization server, or 401
 * with `WWW-Authenticate: DPoP error="use_dpop_nonce"` from a resource server.
 */
async function isUseDPoPNonceError(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401) {
    return false;
  }

  if ((response.headers.get('WWW-Authenticate') ?? '').includes('use_dpop_nonce')) {
    return true;
  }

  try {
    const body = (await response.clone().json()) as { error?: unknown } | null;
    return body?.error === 'use_dpop_nonce';
  } catch {
    return false;
  }
}

interface DPoPRequest {
  url: string;
  method: 'GET' | 'POST';
  key: DPoPKey;
  nonce?: string;
  accessToken?: string;
  /**
   * Form body factory. Called again for the retry so single-use members (the
   * client assertion `jti`) are never sent twice.
   */
  createBody?: () => Promise<URLSearchParams>;
}

interface DPoPResponse {
  response: Response;
  /** The most recent `DPoP-Nonce` this server handed out. */
  nonce: string | undefined;
}

/**
 * Sends a DPoP-bound request. Server nonces are mandatory in atproto, and the
 * first request of a login cannot know the current one, so a `use_dpop_nonce`
 * refusal that carries a new `DPoP-Nonce` is retried exactly once with it.
 */
async function fetchWithDPoP(request: DPoPRequest): Promise<DPoPResponse> {
  const send = async (nonce: string | undefined) => {
    const headers = new Headers({
      Accept: 'application/json',
      DPoP: await createDPoPProof(request.key, {
        method: request.method,
        url: request.url,
        nonce,
        accessToken: request.accessToken,
      }),
    });

    if (request.accessToken) {
      headers.set('Authorization', `DPoP ${request.accessToken}`);
    }

    let body: URLSearchParams | undefined;
    if (request.createBody) {
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      body = await request.createBody();
    }

    return fetch(request.url, { method: request.method, headers, body });
  };

  const firstResponse = await send(request.nonce);
  const firstNonce = firstResponse.headers.get('DPoP-Nonce') ?? request.nonce;

  if (firstNonce && firstNonce !== request.nonce && (await isUseDPoPNonceError(firstResponse))) {
    const secondResponse = await send(firstNonce);
    return { response: secondResponse, nonce: secondResponse.headers.get('DPoP-Nonce') ?? firstNonce };
  }

  return { response: firstResponse, nonce: firstNonce };
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).substring(0, 200);
  } catch {
    return '';
  }
}

/**
 * Fetches a public JSON document. Metadata must be a plain 200 — atproto
 * forbids following redirects for it — so redirects are not followed.
 */
async function fetchPublicJSON(url: string, failureCode: string, description: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'manual' });
  } catch (error) {
    throw new BlueskyFlowError(failureCode, description, {
      url,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (response.status !== 200) {
    throw new BlueskyFlowError(failureCode, description, {
      url,
      status: response.status,
      body: await readErrorBody(response),
    });
  }

  try {
    return await response.json();
  } catch {
    throw new BlueskyFlowError(failureCode, description, { url, reason: 'response is not JSON' });
  }
}

function parseOrFail<Parsed>(
  parse: (data: unknown) => Parsed,
  data: unknown,
  failureCode: string,
  description: string
): Parsed {
  try {
    return parse(data);
  } catch (error) {
    throw new BlueskyFlowError(failureCode, description, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ResolvedIdentity {
  did: string;
  pdsURL: string;
}

/**
 * handle → DID → DID document → PDS. The DID document must claim the handle
 * back (bidirectional verification); otherwise anyone who controls a handle
 * resolver response could point a handle at someone else's account.
 */
export async function resolveIdentity(handle: string): Promise<ResolvedIdentity> {
  const failureCode = 'identity_resolution_failed';

  const resolveHandleURL = new URL(BLUESKY_HANDLE_RESOLUTION_ENDPOINT);
  resolveHandleURL.searchParams.set('handle', handle);

  const { did } = parseOrFail(
    parseBlueskyResolveHandleResponse,
    await fetchPublicJSON(resolveHandleURL.toString(), failureCode, 'Could not resolve the Bluesky handle'),
    failureCode,
    'Could not resolve the Bluesky handle'
  );

  const documentURL = createBlueskyDIDDocumentURL(did);
  if (!documentURL) {
    throw new BlueskyFlowError(failureCode, 'The account uses an unsupported DID method', { did });
  }

  const document = parseOrFail(
    parseBlueskyDIDDocument,
    await fetchPublicJSON(documentURL, failureCode, 'Could not load the DID document'),
    failureCode,
    'Could not load the DID document'
  );

  if (document.id !== did) {
    throw new BlueskyFlowError(failureCode, 'The DID document does not describe the resolved DID', { did });
  }

  if (!blueskyDIDDocumentClaimsHandle(document, handle)) {
    throw new BlueskyFlowError(failureCode, 'The DID document does not claim this handle', { did, handle });
  }

  const pdsURL = findBlueskyPDSURL(document);
  if (!pdsURL) {
    throw new BlueskyFlowError(failureCode, 'The DID document declares no personal data server', { did });
  }

  return { did, pdsURL };
}

function isHTTPSURL(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Loads and checks `<issuer>/.well-known/oauth-authorization-server`. The
 * metadata's `issuer` must be exactly the origin it was fetched from.
 */
export async function fetchAuthorizationServerMetadata(issuer: string): Promise<BlueskyAuthorizationServerMetadata> {
  const failureCode = 'authorization_server_discovery_failed';
  const description = 'Could not load the Bluesky authorization server metadata';

  const metadata = parseOrFail(
    parseBlueskyAuthorizationServerMetadata,
    await fetchPublicJSON(`${issuer}${BLUESKY_AUTHORIZATION_SERVER_METADATA_PATH}`, failureCode, description),
    failureCode,
    description
  );

  if (metadata.issuer !== issuer) {
    throw new BlueskyFlowError(failureCode, 'The authorization server metadata names a different issuer', {
      expected: issuer,
      actual: metadata.issuer,
    });
  }

  const endpoints = [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.pushed_authorization_request_endpoint,
  ];
  if (!endpoints.every(isHTTPSURL)) {
    throw new BlueskyFlowError(failureCode, 'The authorization server metadata lists a non-https endpoint', { issuer });
  }

  if (
    metadata.dpop_signing_alg_values_supported &&
    !metadata.dpop_signing_alg_values_supported.includes(BLUESKY_SIGNING_ALGORITHM)
  ) {
    throw new BlueskyFlowError(failureCode, 'The authorization server does not accept ES256 DPoP proofs', { issuer });
  }

  if (
    metadata.token_endpoint_auth_methods_supported &&
    !metadata.token_endpoint_auth_methods_supported.includes('private_key_jwt')
  ) {
    throw new BlueskyFlowError(failureCode, 'The authorization server does not accept private_key_jwt clients', { issuer });
  }

  return metadata;
}

/**
 * PDS → `/.well-known/oauth-protected-resource` → `authorization_servers[0]`
 * → authorization server metadata.
 */
export async function discoverAuthorizationServer(pdsURL: string): Promise<BlueskyAuthorizationServerMetadata> {
  const failureCode = 'authorization_server_discovery_failed';
  const description = 'Could not find the Bluesky authorization server';

  const resourceMetadata = parseOrFail(
    parseBlueskyProtectedResourceMetadata,
    await fetchPublicJSON(`${pdsURL}${BLUESKY_PROTECTED_RESOURCE_METADATA_PATH}`, failureCode, description),
    failureCode,
    description
  );

  const issuer = parseBlueskyServerOrigin(resourceMetadata.authorization_servers[0]);
  if (!issuer) {
    throw new BlueskyFlowError(failureCode, description, {
      pdsURL,
      authorizationServer: resourceMetadata.authorization_servers[0],
    });
  }

  return fetchAuthorizationServerMetadata(issuer);
}

export interface PushedAuthorizationRequestOptions {
  metadata: BlueskyAuthorizationServerMetadata;
  clientKey: ClientSigningKey;
  clientID: string;
  redirectURI: string;
  scope: string;
  state: string;
  codeChallenge: string;
  loginHint: string;
  dpopKey: DPoPKey;
}

/**
 * Pushed authorization request, DPoP-bound from the first request and
 * authenticated with a client assertion.
 */
export async function pushAuthorizationRequest(
  options: PushedAuthorizationRequestOptions
): Promise<{ requestURI: string; nonce: string | undefined }> {
  const { metadata } = options;

  const { response, nonce } = await fetchWithDPoP({
    url: metadata.pushed_authorization_request_endpoint,
    method: 'POST',
    key: options.dpopKey,
    createBody: async () =>
      new URLSearchParams({
        client_id: options.clientID,
        response_type: 'code',
        redirect_uri: options.redirectURI,
        scope: options.scope,
        state: options.state,
        code_challenge: options.codeChallenge,
        code_challenge_method: 'S256',
        login_hint: options.loginHint,
        client_assertion_type: BLUESKY_CLIENT_ASSERTION_TYPE,
        client_assertion: await createClientAssertion(options.clientKey, options.clientID, metadata.issuer),
      }),
  });

  if (!response.ok) {
    throw new BlueskyFlowError('authorization_request_failed', 'The Bluesky authorization server refused the login request', {
      status: response.status,
      body: await readErrorBody(response),
    });
  }

  const { request_uri: requestURI } = parseOrFail(
    parseBlueskyPushedAuthorizationResponse,
    await response.json(),
    'authorization_request_failed',
    'The Bluesky authorization server returned an invalid response'
  );

  return { requestURI, nonce };
}

export interface AuthorizationCodeExchangeOptions {
  metadata: BlueskyAuthorizationServerMetadata;
  clientKey: ClientSigningKey;
  clientID: string;
  redirectURI: string;
  code: string;
  codeVerifier: string;
  dpopKey: DPoPKey;
  nonce: string | undefined;
}

/**
 * Token request. The caller still has to check `sub` against the DID the
 * login started with — the response alone proves nothing about the account.
 */
export async function exchangeAuthorizationCode(
  options: AuthorizationCodeExchangeOptions
): Promise<{ tokens: BlueskyTokenResponse; nonce: string | undefined }> {
  const failureCode = 'token_exchange_failed';
  const { metadata } = options;

  const { response, nonce } = await fetchWithDPoP({
    url: metadata.token_endpoint,
    method: 'POST',
    key: options.dpopKey,
    nonce: options.nonce,
    createBody: async () =>
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: options.redirectURI,
        code_verifier: options.codeVerifier,
        client_id: options.clientID,
        client_assertion_type: BLUESKY_CLIENT_ASSERTION_TYPE,
        client_assertion: await createClientAssertion(options.clientKey, options.clientID, metadata.issuer),
      }),
  });

  if (!response.ok) {
    throw new BlueskyFlowError(failureCode, 'Failed to exchange authorization code for tokens', {
      status: response.status,
      body: await readErrorBody(response),
    });
  }

  const tokens = parseOrFail(
    parseBlueskyTokenResponse,
    await response.json(),
    failureCode,
    'The Bluesky token response is invalid'
  );

  if (tokens.token_type.toLowerCase() !== 'dpop') {
    throw new BlueskyFlowError(failureCode, 'The Bluesky token is not DPoP bound', { tokenType: tokens.token_type });
  }

  if (!blueskyScopeIncludesAtproto(tokens.scope)) {
    throw new BlueskyFlowError(failureCode, 'The Bluesky session was not granted the atproto scope', { scope: tokens.scope });
  }

  return { tokens, nonce };
}

/**
 * `com.atproto.server.getSession` on the account's PDS, with the access token
 * under the DPoP scheme and a proof carrying `ath`.
 */
export async function fetchSession(options: {
  pdsURL: string;
  accessToken: string;
  dpopKey: DPoPKey;
  nonce: string | undefined;
}): Promise<BlueskySessionResponse> {
  const failureCode = 'user_info_failed';
  const description = 'Failed to fetch user information from Bluesky';

  const { response } = await fetchWithDPoP({
    url: `${options.pdsURL}${BLUESKY_USER_INFO_PATH}`,
    method: 'GET',
    key: options.dpopKey,
    nonce: options.nonce,
    accessToken: options.accessToken,
  });

  if (!response.ok) {
    throw new BlueskyFlowError(failureCode, description, {
      status: response.status,
      body: await readErrorBody(response),
    });
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new BlueskyFlowError(failureCode, description, { reason: 'response is not JSON' });
  }

  return parseOrFail(parseBlueskySessionResponse, data, failureCode, description);
}
