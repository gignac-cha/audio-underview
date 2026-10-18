/**
 * The rules the crawler manager applies to environment variables, checked here first so that
 * a mistake shows next to the input instead of coming back as a failed request.
 */

export const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAXIMUM_ENVIRONMENT_VARIABLES = 100;
export const MINIMUM_ENVIRONMENT_VARIABLE_VALUE_LENGTH = 4;
export const MAXIMUM_ENVIRONMENT_VARIABLE_VALUE_LENGTH = 16_384;

export function validateEnvironmentVariableName(name: string): string | undefined {
  if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
    return 'Name must match ^[A-Z_][A-Z0-9_]{0,63}$ (uppercase letters, digits and underscores, up to 64 characters).';
  }
  return undefined;
}

export function validateEnvironmentVariableValue(value: string): string | undefined {
  if (
    value.length < MINIMUM_ENVIRONMENT_VARIABLE_VALUE_LENGTH ||
    value.length > MAXIMUM_ENVIRONMENT_VARIABLE_VALUE_LENGTH
  ) {
    return `Value must be ${MINIMUM_ENVIRONMENT_VARIABLE_VALUE_LENGTH} to ${MAXIMUM_ENVIRONMENT_VARIABLE_VALUE_LENGTH.toLocaleString('en-US')} characters.`;
  }
  return undefined;
}
