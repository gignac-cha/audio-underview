import { createWorkerLogger, type Logger } from '@audio-underview/logger';
import { describeError, extractAuditFingerprint, recordAuditEvent, type AuditAction } from './audit.ts';
import { decodeBase64, openProviderKey, rewrapDataEncryptionKey, sealProviderKey } from './envelope.ts';
import {
  readAuditHashSalt,
  readGatewayOptions,
  readInternalToken,
  readKeyEncryptionKeySecrets,
  readKeyEncryptionKeyVersion,
  type Environment,
} from './environment.ts';
import {
  PROVIDER_NAMES,
  buildProviderHeaders,
  buildProviderURL,
  isProviderName,
  type ProviderName,
} from './providers.ts';
import { createUserVaultStorage, type UserVaultStorage } from './storage.ts';
import { isWellFormedProviderKey, validateProviderKey } from './validation.ts';

export type { Environment } from './environment.ts';

export const INTERNAL_TOKEN_HEADER_NAME = 'x-provider-key-vault-token';
export const USER_ID_MAXIMUM_LENGTH = 200;
export const DEFAULT_AUDIT_EVENT_LIMIT = 50;
export const PROXY_TIMEOUT_MILLISECONDS = 240_000;
export const PROXY_BODY_BASE64_MAXIMUM_LENGTH = 16_000_000;
export const PROXY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const REDACTED_KEY_MARKER = '[REDACTED]';

const logger = createWorkerLogger({
  defaultContext: {
    module: 'api-key-vault-worker',
  },
});

type RequestBody = Record<string, unknown>;

interface RouteContext {
  environment: Environment;
  body: RequestBody;
  userID: string;
  storage: UserVaultStorage;
  keyEncryptionKeySecrets: string[];
  logger: Logger;
}

type RouteHandler = (context: RouteContext) => Promise<Response>;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Replaces every occurrence of the plaintext key, for text that came back from a provider.
 */
function removeKey(text: string, key: string): string {
  return text.split(key).join(REDACTED_KEY_MARKER);
}

/**
 * External error text, redacted and truncated, with the key removed even if it
 * does not match a known credential pattern.
 */
function describeFailure(error: unknown, key: string): string {
  return describeError(removeKey(error instanceof Error ? `${error.name}: ${error.message}` : String(error), key));
}

function isPlainObject(value: unknown): value is RequestBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function audit(context: RouteContext, provider: ProviderName, action: AuditAction, at?: string): Promise<void> {
  await recordAuditEvent({
    storage: context.storage,
    logger: context.logger,
    salt: readAuditHashSalt(context.environment),
    provider,
    action,
    fingerprint: extractAuditFingerprint(context.body),
    at,
  });
}

const handlePut: RouteHandler = async (context) => {
  const { body } = context;
  if (!isProviderName(body.provider)) {
    return jsonResponse(400, { error: 'unknown_provider' });
  }
  const provider = body.provider;
  const key = body.key;

  if (!isWellFormedProviderKey(key)) {
    context.logger.warn('Provider key rejected', { provider, reason: 'malformed' }, { function: 'handlePut' });
    return jsonResponse(400, { error: 'invalid_key' });
  }

  const gateway = readGatewayOptions(context.environment);
  const validation = await validateProviderKey(provider, key, gateway);
  if (validation.result === 'invalid') {
    context.logger.warn(
      'Provider key rejected',
      { provider, reason: 'provider_rejected', status: validation.status },
      { function: 'handlePut' },
    );
    return jsonResponse(400, { error: 'invalid_key' });
  }
  if (validation.result === 'unavailable') {
    context.logger.warn(
      'Provider key validation unavailable',
      {
        provider,
        status: validation.status,
        reason: validation.failure === null ? null : describeFailure(validation.failure, key),
      },
      { function: 'handlePut' },
    );
    return jsonResponse(503, { error: 'validation_unavailable' });
  }

  const existing = await context.storage.readProviderKey(provider);

  const now = new Date().toISOString();
  const sealed = await sealProviderKey({
    plaintextKey: key,
    binding: {
      userID: context.userID,
      provider,
      keyVersion: readKeyEncryptionKeyVersion(context.environment),
      createdAt: now,
    },
    keyEncryptionKeySecrets: context.keyEncryptionKeySecrets,
  });
  await context.storage.writeProviderKey({ provider, ...sealed, validatedAt: now });
  context.logger.info('Provider key stored', { provider, last4: sealed.last4 }, { function: 'handlePut' });

  await audit(context, provider, existing === null ? 'registered' : 'replaced', now);

  return jsonResponse(200, { provider, configured: true, last4: sealed.last4, validatedAt: now });
};

const handleDelete: RouteHandler = async (context) => {
  const { body } = context;
  if (!isProviderName(body.provider)) {
    return jsonResponse(400, { error: 'unknown_provider' });
  }
  const provider = body.provider;
  const removed = await context.storage.deleteProviderKey(provider);
  context.logger.info('Provider key deleted', { provider, removed }, { function: 'handleDelete' });
  if (removed) {
    await audit(context, provider, 'removed');
  }
  return jsonResponse(200, { removed });
};

const handleStatus: RouteHandler = async (context) => {
  const records = await context.storage.listProviderKeys();
  const keys = PROVIDER_NAMES.map((provider) => {
    const record = records.find((candidate) => candidate.provider === provider);
    return record === undefined
      ? { provider, configured: false, last4: null, validatedAt: null }
      : { provider, configured: true, last4: record.last4, validatedAt: record.validatedAt };
  });
  return jsonResponse(200, { keys });
};

const handleAudit: RouteHandler = async (context) => {
  const limit = typeof context.body.limit === 'number' ? context.body.limit : DEFAULT_AUDIT_EVENT_LIMIT;
  try {
    const events = await context.storage.listAuditEvents(limit);
    return jsonResponse(200, { events });
  } catch (error) {
    context.logger.error('Audit event read failed', undefined, {
      function: 'handleAudit',
      metadata: { reason: describeError(error) },
    });
    return jsonResponse(200, { events: [] });
  }
};

const handleRewrap: RouteHandler = async (context) => {
  const records = await context.storage.listProviderKeys();
  let rewrapped = 0;
  let unrecoverable = 0;
  for (const record of records) {
    const replacement = await rewrapDataEncryptionKey({
      userID: context.userID,
      envelope: record,
      keyEncryptionKeySecrets: context.keyEncryptionKeySecrets,
    });
    if (replacement === null) {
      unrecoverable += 1;
      context.logger.error('Provider key decryption failed', undefined, {
        function: 'handleRewrap',
        metadata: { provider: record.provider, keyVersion: record.keyVersion },
      });
      continue;
    }
    const replaced = await context.storage.replaceWrappedDataEncryptionKey(
      record.provider,
      record.wrappedDataEncryptionKey,
      replacement,
    );
    if (replaced) {
      rewrapped += 1;
    }
  }
  context.logger.info('Provider keys rewrapped', { rewrapped, unrecoverable }, { function: 'handleRewrap' });
  return jsonResponse(200, { rewrapped, unrecoverable });
};

function proxyError(status: number, error: string): Response {
  return jsonResponse(status, { ok: false, error });
}

const handleProxy: RouteHandler = async (context) => {
  const { body } = context;
  if (!isProviderName(body.provider)) {
    return proxyError(400, 'unknown_provider');
  }
  const provider = body.provider;

  if (typeof body.path !== 'string') {
    return proxyError(400, 'invalid_path');
  }

  let method: string = 'POST';
  if (body.method !== undefined) {
    if (typeof body.method !== 'string') {
      return proxyError(400, 'invalid_request');
    }
    method = body.method.toUpperCase();
  }
  if (!(PROXY_METHODS as readonly string[]).includes(method)) {
    return proxyError(400, 'invalid_request');
  }

  if (body.body !== undefined && typeof body.body !== 'string') {
    return proxyError(400, 'invalid_request');
  }

  // fetch throws on a GET with a body. Reject it here as the caller's mistake,
  // before it can surface as provider_unreachable.
  if (method === 'GET' && (body.body !== undefined || body.bodyBase64 !== undefined)) {
    return proxyError(400, 'invalid_request');
  }

  let requestBody: string | Uint8Array<ArrayBuffer> | undefined = body.body;
  if (body.bodyBase64 !== undefined) {
    if (
      typeof body.bodyBase64 !== 'string' ||
      body.body !== undefined ||
      body.bodyBase64.length > PROXY_BODY_BASE64_MAXIMUM_LENGTH
    ) {
      return proxyError(400, 'invalid_request');
    }
    try {
      requestBody = decodeBase64(body.bodyBase64);
    } catch {
      return proxyError(400, 'invalid_request');
    }
  }

  const gateway = readGatewayOptions(context.environment);
  const target = buildProviderURL(provider, body.path, gateway);
  if (!target.ok) {
    context.logger.warn('Provider URL rejected', { provider, reason: target.error }, { function: 'handleProxy' });
    return proxyError(400, target.error);
  }

  const record = await context.storage.readProviderKey(provider);
  if (record === null) {
    return proxyError(404, 'no_key');
  }
  const key = await openProviderKey({
    userID: context.userID,
    envelope: record,
    keyEncryptionKeySecrets: context.keyEncryptionKeySecrets,
  });
  if (key === null) {
    context.logger.error('Provider key decryption failed', undefined, {
      function: 'handleProxy',
      metadata: { provider, keyVersion: record.keyVersion },
    });
    return proxyError(404, 'no_key');
  }

  await audit(context, provider, 'used');

  let response: Response;
  let responseText: string;
  try {
    // A redirect is passed back as data, never followed: following it would
    // carry the key headers to whatever origin the Location names.
    response = await fetch(target.url, {
      method,
      headers: buildProviderHeaders(provider, key, body.headers, gateway),
      body: requestBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MILLISECONDS),
    });
    // Reading the body stays inside the try: a stream that breaks or times out
    // halfway is the same failure as a connection that never opened.
    responseText = await response.text();
  } catch (error) {
    context.logger.error('Provider fetch failed', undefined, {
      function: 'handleProxy',
      metadata: { provider, reason: describeFailure(error, key) },
    });
    return proxyError(502, 'provider_unreachable');
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

  return jsonResponse(200, {
    ok: true,
    provider,
    status: response.status,
    contentType: removeKey(contentType, key),
    body: removeKey(responseText, key),
  });
};

const ROUTES: Readonly<Record<string, RouteHandler>> = {
  '/internal/keys/put': handlePut,
  '/internal/keys/delete': handleDelete,
  '/internal/keys/status': handleStatus,
  '/internal/keys/audit': handleAudit,
  '/internal/keys/rewrap': handleRewrap,
  '/internal/proxy': handleProxy,
};

export async function handleRequest(request: Request, environment: Environment): Promise<Response> {
  if (request.method !== 'POST') {
    return jsonResponse(404, { error: 'not_found' });
  }

  const internalToken = readInternalToken(environment);
  if (internalToken !== null) {
    const providedToken = request.headers.get(INTERNAL_TOKEN_HEADER_NAME);
    if (providedToken === null || !(await constantTimeEqual(providedToken, internalToken))) {
      return jsonResponse(401, { error: 'unauthorized' });
    }
  }

  const pathname = new URL(request.url).pathname;
  const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (route === undefined) {
    return jsonResponse(404, { error: 'not_found' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_request' });
  }
  if (!isPlainObject(body)) {
    return jsonResponse(400, { error: 'invalid_request' });
  }

  const userID = body.userId;
  if (typeof userID !== 'string' || userID.length < 1 || userID.length > USER_ID_MAXIMUM_LENGTH) {
    return jsonResponse(400, { error: 'invalid_request' });
  }

  const keyEncryptionKeySecrets = readKeyEncryptionKeySecrets(environment);
  if (keyEncryptionKeySecrets.length === 0) {
    logger.error('Key encryption key is not configured', undefined, { function: 'handleRequest' });
    return jsonResponse(503, { error: 'vault_unavailable' });
  }

  return route({
    environment,
    body,
    userID,
    storage: createUserVaultStorage(environment.DB, userID),
    keyEncryptionKeySecrets,
    logger,
  });
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    try {
      return await handleRequest(request, environment);
    } catch (error) {
      logger.error('Unhandled worker error', undefined, {
        function: 'fetch',
        metadata: { reason: describeError(error) },
      });
      return jsonResponse(500, { error: 'server_error' });
    }
  },
} satisfies ExportedHandler<Environment>;
