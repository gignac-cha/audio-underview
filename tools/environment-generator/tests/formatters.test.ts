import { describe, expect, test } from 'vitest';

import {
  isValidSecretValue,
  escapeEnvironmentValue,
  formatEnvironmentLine,
  buildEnvironmentFileContent,
} from '../sources/formatters.ts';

describe('isValidSecretValue', () => {
  test('accepts a normal value', () => {
    expect(isValidSecretValue('some-secret')).toBe(true);
  });

  test('rejects an empty string', () => {
    expect(isValidSecretValue('')).toBe(false);
  });

  test('rejects the REPLACE_ME placeholder', () => {
    expect(isValidSecretValue('REPLACE_ME')).toBe(false);
  });
});

describe('escapeEnvironmentValue', () => {
  test('passes through a plain value', () => {
    expect(escapeEnvironmentValue('https://example.com')).toBe('https://example.com');
  });

  test('escapes double quotes', () => {
    expect(escapeEnvironmentValue('a"b')).toBe('a\\"b');
  });

  test('escapes backslashes before quotes', () => {
    expect(escapeEnvironmentValue('a\\"b')).toBe('a\\\\\\"b');
  });

  test('escapes newlines (PEM private key 등 여러 줄 값)', () => {
    expect(escapeEnvironmentValue('line1\nline2')).toBe('line1\\nline2');
  });
});

describe('formatEnvironmentLine', () => {
  test('formats NAME="value"', () => {
    expect(formatEnvironmentLine('FRONTEND_URL', 'https://audio-underview.pages.dev')).toBe(
      'FRONTEND_URL="https://audio-underview.pages.dev"',
    );
  });
});

describe('buildEnvironmentFileContent', () => {
  test('writes only resolved variables, in definition order, with trailing newline', () => {
    const resolved = new Map([
      ['B_KEY', 'value-b'],
      ['A_KEY', 'value-a'],
    ]);

    expect(buildEnvironmentFileContent(['A_KEY', 'MISSING_KEY', 'B_KEY'], resolved)).toBe(
      'A_KEY="value-a"\nB_KEY="value-b"\n',
    );
  });

  test('returns undefined when nothing is resolved', () => {
    expect(buildEnvironmentFileContent(['A_KEY'], new Map())).toBeUndefined();
  });
});
