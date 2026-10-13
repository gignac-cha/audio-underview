import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import { type Environment, createUserVaultClient } from '../environment.ts';
import { UserVaultError } from '../user-vault-client.ts';

/**
 * The environment variables of the user. Values are kept by user-vault-worker; they go there in a
 * PUT and never come back in any response or log.
 */

export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const ENVIRONMENT_VARIABLE_VALUE_MINIMUM_LENGTH = 4;
export const ENVIRONMENT_VARIABLE_VALUE_MAXIMUM_LENGTH = 16_384;

const INVALID_NAME_MESSAGE = 'Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$';
const INVALID_VALUE_MESSAGE = `Field 'value' must be a string of ${ENVIRONMENT_VARIABLE_VALUE_MINIMUM_LENGTH} to ${ENVIRONMENT_VARIABLE_VALUE_MAXIMUM_LENGTH} characters`;

function vaultErrorResponse(error: unknown, context: ResponseContext): Response {
  const status = error instanceof UserVaultError ? error.status : 0;
  if (status === 409) {
    return errorResponse('limit_exceeded', 'At most 100 environment variables are allowed', 409, context);
  }
  if (status === 400) {
    // The request was checked here before, so the vault refusing it is a bug
    return errorResponse('server_error', 'An unexpected error occurred', 500, context);
  }
  return errorResponse('service_unavailable', 'Environment variables are not available right now', 503, context);
}

export async function handleListEnvironmentVariables(
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  try {
    const variables = await createUserVaultClient(environment).listEnvironmentVariables(userUUID);
    return jsonResponse({ data: variables }, 200, context);
  } catch (error) {
    return vaultErrorResponse(error, context);
  }
}

export async function handlePutEnvironmentVariable(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  name: string,
  userUUID: string,
): Promise<Response> {
  if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
    return errorResponse('invalid_request', INVALID_NAME_MESSAGE, 400, context);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }
  const value = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).value
    : undefined;
  if (
    typeof value !== 'string' ||
    value.length < ENVIRONMENT_VARIABLE_VALUE_MINIMUM_LENGTH ||
    value.length > ENVIRONMENT_VARIABLE_VALUE_MAXIMUM_LENGTH
  ) {
    return errorResponse('invalid_request', INVALID_VALUE_MESSAGE, 400, context);
  }

  try {
    const stored = await createUserVaultClient(environment).putEnvironmentVariable(userUUID, name, value);
    return jsonResponse(
      { name: stored.name, created_at: stored.created_at, updated_at: stored.updated_at },
      stored.created ? 201 : 200,
      context,
    );
  } catch (error) {
    return vaultErrorResponse(error, context);
  }
}

export async function handleDeleteEnvironmentVariable(
  environment: Environment,
  context: ResponseContext,
  name: string,
  userUUID: string,
): Promise<Response> {
  if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
    return errorResponse('invalid_request', INVALID_NAME_MESSAGE, 400, context);
  }
  try {
    const deleted = await createUserVaultClient(environment).deleteEnvironmentVariable(userUUID, name);
    if (!deleted) {
      return errorResponse('not_found', 'Environment variable not found', 404, context);
    }
    return jsonResponse({ deleted: true }, 200, context);
  } catch (error) {
    return vaultErrorResponse(error, context);
  }
}
