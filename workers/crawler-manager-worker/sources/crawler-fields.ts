import { isSafeURLPattern } from './safe-url-pattern.ts';
import { CRAWLER_CODE_MAXIMUM_LENGTH } from './crawler-runtime/run-crawler.ts';
import {
  ENVIRONMENT_VARIABLE_NAME_PATTERN,
  INVALID_ENVIRONMENT_VARIABLE_NAME_MESSAGE,
} from './handlers/environment-variables.ts';

/**
 * The checks of the crawler fields that a crawler body (POST /crawlers, PUT /crawlers/:id) and a
 * test run body share. Each answers the error description of the first problem, or undefined.
 */

export const CRAWLER_NAME_MAXIMUM_LENGTH = 255;
export const CRAWLER_URL_PATTERN_MAXIMUM_LENGTH = 2048;
/** As the environment variables a user can have */
export const ENVIRONMENT_VARIABLE_NAMES_MAXIMUM_COUNT = 100;

export function isJSONObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The code is a string that is not blank */
export function checkCodePresence(code: unknown): string | undefined {
  if (typeof code !== 'string' || !code.trim()) {
    return "Field 'code' is required and must be a non-empty string";
  }
  return undefined;
}

export function checkCodeLength(code: string): string | undefined {
  if (code.length > CRAWLER_CODE_MAXIMUM_LENGTH) {
    return `Field 'code' must not exceed ${CRAWLER_CODE_MAXIMUM_LENGTH} characters`;
  }
  return undefined;
}

/** The length of a url_pattern, a pattern safe from ReDoS, and a valid regex */
export function checkURLPattern(urlPattern: string): string | undefined {
  if (urlPattern.length > CRAWLER_URL_PATTERN_MAXIMUM_LENGTH) {
    return `Field 'url_pattern' must not exceed ${CRAWLER_URL_PATTERN_MAXIMUM_LENGTH} characters`;
  }
  if (!isSafeURLPattern(urlPattern)) {
    return "Field 'url_pattern' contains potentially unsafe regex pattern";
  }
  try {
    new RegExp(urlPattern);
  } catch {
    return "Field 'url_pattern' must be a valid regex";
  }
  return undefined;
}

/** Names of the environment variable API, without duplicates, at most 100 */
export function checkEnvironmentVariableNames(names: unknown): string | undefined {
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    return "Field 'environment_variable_names' must be an array of strings";
  }
  if (!names.every((name) => ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name))) {
    return INVALID_ENVIRONMENT_VARIABLE_NAME_MESSAGE;
  }
  if (new Set(names).size !== names.length) {
    return "Field 'environment_variable_names' must not contain duplicates";
  }
  if (names.length > ENVIRONMENT_VARIABLE_NAMES_MAXIMUM_COUNT) {
    return `Field 'environment_variable_names' must not exceed ${ENVIRONMENT_VARIABLE_NAMES_MAXIMUM_COUNT} names`;
  }
  return undefined;
}
