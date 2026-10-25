import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import { type Environment, createUserVaultClient } from '../environment.ts';
import { type ClientFingerprint, UserVaultError, isProviderName } from '../user-vault-client.ts';

/**
 * The provider keys of the user. Keys are kept by user-vault-worker; they go there in a PUT and
 * never come back in any response or log.
 */

export const PROVIDER_KEY_MINIMUM_LENGTH = 16;
export const PROVIDER_KEY_MAXIMUM_LENGTH = 512;
export const PROVIDER_KEY_AUDIT_EVENT_LIMIT = 50;

const INVALID_KEY_MESSAGE = `Field 'key' must be ${PROVIDER_KEY_MINIMUM_LENGTH} to ${PROVIDER_KEY_MAXIMUM_LENGTH} printable characters without spaces`;

/**
 * 16 to 512 characters, every one of them printable ASCII (0x21 to 0x7E). The vault checks the same rule.
 */
export function isWellFormedProviderKey(key: unknown): key is string {
  if (typeof key !== 'string') {
    return false;
  }
  if (key.length < PROVIDER_KEY_MINIMUM_LENGTH || key.length > PROVIDER_KEY_MAXIMUM_LENGTH) {
    return false;
  }
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

function unknownProviderResponse(context: ResponseContext): Response {
  return errorResponse('not_found', 'Unknown provider', 404, context);
}

function vaultErrorResponse(error: unknown, context: ResponseContext): Response {
  const status = error instanceof UserVaultError ? error.status : 0;
  if (status === 400) {
    // The request was checked here before, so the vault refusing it is a bug
    return errorResponse('server_error', 'An unexpected error occurred', 500, context);
  }
  return errorResponse('service_unavailable', 'Provider keys are not available right now', 503, context);
}

function putErrorResponse(error: unknown, context: ResponseContext): Response {
  if (error instanceof UserVaultError) {
    if (error.status === 400 && error.code === 'invalid_key') {
      return errorResponse('invalid_key', 'The provider did not accept this key', 400, context);
    }
    if (error.status === 503 && error.code === 'validation_unavailable') {
      return errorResponse(
        'validation_unavailable',
        'The provider could not be reached to check the key. Try again later',
        503,
        context,
      );
    }
  }
  return vaultErrorResponse(error, context);
}

/**
 * The client of the request as the audit trail keeps it; the vault stores a hash of each. A header
 * the request does not have is left out.
 */
function readClientFingerprint(request: Request): ClientFingerprint {
  const fingerprint: ClientFingerprint = {};
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip !== null && ip.length > 0) {
    fingerprint.ip = ip;
  }
  const userAgent = request.headers.get('User-Agent');
  if (userAgent !== null && userAgent.length > 0) {
    fingerprint.userAgent = userAgent;
  }
  return fingerprint;
}

export async function handleListProviderKeys(
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  try {
    const statuses = await createUserVaultClient(environment).getProviderKeyStatus(userUUID);
    return jsonResponse(
      {
        data: statuses.map(({ provider, configured, last4, validatedAt }) => ({
          provider,
          configured,
          last4,
          validated_at: validatedAt,
        })),
      },
      200,
      context,
    );
  } catch (error) {
    return vaultErrorResponse(error, context);
  }
}

export async function handleListProviderKeyAudit(
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  try {
    const events = await createUserVaultClient(environment).listProviderKeyAudit(userUUID, PROVIDER_KEY_AUDIT_EVENT_LIMIT);
    return jsonResponse({ data: events }, 200, context);
  } catch (error) {
    return vaultErrorResponse(error, context);
  }
}

export async function handlePutProviderKey(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  provider: string,
  userUUID: string,
): Promise<Response> {
  if (!isProviderName(provider)) {
    return unknownProviderResponse(context);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }
  const key = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).key
    : undefined;
  if (!isWellFormedProviderKey(key)) {
    return errorResponse('invalid_request', INVALID_KEY_MESSAGE, 400, context);
  }

  try {
    const stored = await createUserVaultClient(environment).putProviderKey(
      userUUID,
      provider,
      key,
      readClientFingerprint(request),
    );
    return jsonResponse(
      { provider: stored.provider, configured: true, last4: stored.last4, validated_at: stored.validatedAt },
      200,
      context,
    );
  } catch (error) {
    return putErrorResponse(error, context);
  }
}

export async function handleDeleteProviderKey(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  provider: string,
  userUUID: string,
): Promise<Response> {
  if (!isProviderName(provider)) {
    return unknownProviderResponse(context);
  }
  try {
    const deleted = await createUserVaultClient(environment).deleteProviderKey(
      userUUID,
      provider,
      readClientFingerprint(request),
    );
    if (!deleted) {
      return errorResponse('not_found', 'Provider key not found', 404, context);
    }
    return jsonResponse({ deleted: true }, 200, context);
  } catch (error) {
    return vaultErrorResponse(error, context);
  }
}
