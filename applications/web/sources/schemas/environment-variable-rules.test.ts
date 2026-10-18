import {
  ENVIRONMENT_VARIABLE_NAME_PATTERN,
  MAXIMUM_ENVIRONMENT_VARIABLES,
  validateEnvironmentVariableName,
  validateEnvironmentVariableValue,
} from './environment-variable-rules.ts';

describe('validateEnvironmentVariableName', () => {
  test.each(['A', 'API_TOKEN', '_PRIVATE', 'BLOG_A_TOKEN', 'TOKEN_2', 'A'.repeat(64)])('accepts %s', (name) => {
    expect(validateEnvironmentVariableName(name)).toBeUndefined();
  });

  test.each(['', 'api_token', '1TOKEN', 'API-TOKEN', 'API TOKEN', 'API_TOKEN ', 'A'.repeat(65), 'TÖKEN'])(
    'rejects "%s"',
    (name) => {
      expect(validateEnvironmentVariableName(name)).toContain('^[A-Z_][A-Z0-9_]{0,63}$');
    },
  );

  test('uses the pattern of the crawler manager', () => {
    expect(ENVIRONMENT_VARIABLE_NAME_PATTERN.source).toBe('^[A-Z_][A-Z0-9_]{0,63}$');
  });
});

describe('validateEnvironmentVariableValue', () => {
  test('accepts 4 to 16,384 characters', () => {
    expect(validateEnvironmentVariableValue('abcd')).toBeUndefined();
    expect(validateEnvironmentVariableValue('a'.repeat(16_384))).toBeUndefined();
  });

  test('rejects a value that is too short or too long', () => {
    expect(validateEnvironmentVariableValue('')).toBe('Value must be 4 to 16,384 characters.');
    expect(validateEnvironmentVariableValue('abc')).toBe('Value must be 4 to 16,384 characters.');
    expect(validateEnvironmentVariableValue('a'.repeat(16_385))).toBe('Value must be 4 to 16,384 characters.');
  });
});

test('an account holds at most 100 environment variables', () => {
  expect(MAXIMUM_ENVIRONMENT_VARIABLES).toBe(100);
});
