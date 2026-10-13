import { openProviderKey, rewrapDataEncryptionKey, sealProviderKey, type StoredEnvelope } from './envelope.ts';
import { readKeyEncryptionKeyVersion } from './environment.ts';
import { jsonResponse, requireKeyEncryptionKey, type RouteContext, type RouteHandler } from './route.ts';
import type { EnvironmentVariableRecord } from './storage.ts';

/**
 * Environment variables of a user: values the user's own crawlers read by name. A value is sealed
 * like a provider key and never leaves the vault except through resolve, which the crawler manager
 * calls only when the user runs a crawler of their own.
 */

export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
// A shorter value cannot be told apart from ordinary text, so it could not be redacted from results.
export const ENVIRONMENT_VARIABLE_VALUE_MINIMUM_LENGTH = 4;
export const ENVIRONMENT_VARIABLE_VALUE_MAXIMUM_LENGTH = 16_384;
export const ENVIRONMENT_VARIABLE_MAXIMUM_COUNT = 100;

// Binds the envelope to the variable name, so a ciphertext moved to another name does not open
const ENVELOPE_PROVIDER_PREFIX = 'environment-variable:';

function isEnvironmentVariableName(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_VARIABLE_NAME_PATTERN.test(value);
}

function isEnvironmentVariableValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= ENVIRONMENT_VARIABLE_VALUE_MINIMUM_LENGTH &&
    value.length <= ENVIRONMENT_VARIABLE_VALUE_MAXIMUM_LENGTH
  );
}

function toStoredEnvelope(record: EnvironmentVariableRecord): StoredEnvelope {
  return {
    provider: `${ENVELOPE_PROVIDER_PREFIX}${record.name}`,
    ciphertext: record.ciphertext,
    initializationVector: record.initializationVector,
    wrappedDataEncryptionKey: record.wrappedDataEncryptionKey,
    dataEncryptionKeyInitializationVector: record.dataEncryptionKeyInitializationVector,
    keyVersion: record.keyVersion,
    // A value is sealed again on every change, so the envelope belongs to the last change
    createdAt: record.updatedAt,
  };
}

export const handleEnvironmentVariableList: RouteHandler = async (context) => {
  const summaries = await context.storage.listEnvironmentVariableSummaries();
  return jsonResponse(200, {
    variables: summaries.map((summary) => ({
      name: summary.name,
      created_at: summary.createdAt,
      updated_at: summary.updatedAt,
    })),
  });
};

export const handleEnvironmentVariablePut: RouteHandler = async (context) => {
  const { body } = context;
  if (!isEnvironmentVariableName(body.name) || !isEnvironmentVariableValue(body.value)) {
    return jsonResponse(400, { error: 'invalid_request' });
  }
  const name = body.name;
  const value = body.value;

  const unavailable = requireKeyEncryptionKey(context);
  if (unavailable !== null) {
    return unavailable;
  }

  const now = new Date().toISOString();
  const keyVersion = readKeyEncryptionKeyVersion(context.environment);
  const sealed = await sealProviderKey({
    plaintextKey: value,
    binding: { userID: context.userID, provider: `${ENVELOPE_PROVIDER_PREFIX}${name}`, keyVersion, createdAt: now },
    keyEncryptionKeySecrets: context.keyEncryptionKeySecrets,
  });
  const record: EnvironmentVariableRecord = {
    name,
    ciphertext: sealed.ciphertext,
    initializationVector: sealed.initializationVector,
    wrappedDataEncryptionKey: sealed.wrappedDataEncryptionKey,
    dataEncryptionKeyInitializationVector: sealed.dataEncryptionKeyInitializationVector,
    keyVersion,
    createdAt: now,
    updatedAt: now,
  };

  let createdAt = await context.storage.updateEnvironmentVariable(record);
  let created = false;
  if (createdAt === null) {
    if (await context.storage.insertEnvironmentVariable(record, ENVIRONMENT_VARIABLE_MAXIMUM_COUNT)) {
      createdAt = now;
      created = true;
    } else {
      // Either the user is at the limit, or the same name was inserted concurrently: replace it then
      createdAt = await context.storage.updateEnvironmentVariable(record);
      if (createdAt === null) {
        context.logger.warn('Environment variable limit reached', { name }, { function: 'handleEnvironmentVariablePut' });
        return jsonResponse(409, { error: 'limit_exceeded' });
      }
    }
  }

  context.logger.info('Environment variable stored', { name, created }, { function: 'handleEnvironmentVariablePut' });
  return jsonResponse(200, { name, created_at: createdAt, updated_at: now, created });
};

export const handleEnvironmentVariableDelete: RouteHandler = async (context) => {
  const { body } = context;
  if (!isEnvironmentVariableName(body.name)) {
    return jsonResponse(400, { error: 'invalid_request' });
  }
  const deleted = await context.storage.deleteEnvironmentVariable(body.name);
  context.logger.info('Environment variable deleted', { name: body.name, deleted }, { function: 'handleEnvironmentVariableDelete' });
  return jsonResponse(200, { deleted });
};

export const handleEnvironmentVariableResolve: RouteHandler = async (context) => {
  const records = await context.storage.listEnvironmentVariables();
  // A user without variables runs crawlers whether or not a key encryption key is configured
  if (records.length === 0) {
    return jsonResponse(200, { variables: {} });
  }

  const unavailable = requireKeyEncryptionKey(context);
  if (unavailable !== null) {
    return unavailable;
  }

  const variables: Record<string, string> = {};
  for (const record of records) {
    const value = await openProviderKey({
      userID: context.userID,
      envelope: toStoredEnvelope(record),
      keyEncryptionKeySecrets: context.keyEncryptionKeySecrets,
    });
    if (value === null) {
      // Fail closed: a run never gets only part of the variables
      context.logger.error('Environment variable decryption failed', undefined, {
        function: 'handleEnvironmentVariableResolve',
        metadata: { userID: context.userID, name: record.name },
      });
      return jsonResponse(500, { error: 'decrypt_failed' });
    }
    variables[record.name] = value;
  }
  return jsonResponse(200, { variables });
};

/**
 * Wraps the data encryption key of every environment variable of the user with the current
 * key encryption key, like the provider keys in /internal/keys/rewrap.
 */
export async function rewrapEnvironmentVariables(
  context: RouteContext,
): Promise<{ rewrapped: number; unrecoverable: number }> {
  const records = await context.storage.listEnvironmentVariables();
  let rewrapped = 0;
  let unrecoverable = 0;
  for (const record of records) {
    const replacement = await rewrapDataEncryptionKey({
      userID: context.userID,
      envelope: toStoredEnvelope(record),
      keyEncryptionKeySecrets: context.keyEncryptionKeySecrets,
    });
    if (replacement === null) {
      unrecoverable += 1;
      context.logger.error('Environment variable decryption failed', undefined, {
        function: 'handleRewrap',
        metadata: { userID: context.userID, name: record.name, keyVersion: record.keyVersion },
      });
      continue;
    }
    const replaced = await context.storage.replaceEnvironmentVariableWrappedDataEncryptionKey(
      record.name,
      record.wrappedDataEncryptionKey,
      replacement,
    );
    if (replaced) {
      rewrapped += 1;
    }
  }
  return { rewrapped, unrecoverable };
}
