import { describe, expect, it } from 'vitest';
import { assertEnvironmentSchema, parseBuildArguments } from './environments.ts';

describe('parseBuildArguments', () => {
  it('reads the environment and --reset', () => {
    expect(parseBuildArguments(['staging'])).toEqual({ environment: 'staging', reset: false });
    expect(parseBuildArguments(['development', '--reset'])).toEqual({ environment: 'development', reset: true });
    expect(parseBuildArguments(['--reset', 'development'])).toEqual({ environment: 'development', reset: true });
  });

  it('rejects public and anything else that is not staging or development', () => {
    for (const environment of ['public', 'PUBLIC', 'production', 'Staging', 'staging ', 'prototype']) {
      expect(() => parseBuildArguments([environment]), environment).toThrow(/only staging and development/);
    }
  });

  it('rejects a missing or extra environment and unknown options', () => {
    expect(() => parseBuildArguments([])).toThrow(/usage/);
    expect(() => parseBuildArguments(['staging', 'development'])).toThrow(/usage/);
    expect(() => parseBuildArguments(['staging', '--force'])).toThrow(/unknown option --force/);
  });
});

describe('assertEnvironmentSchema', () => {
  it('allows only staging and development', () => {
    expect(() => assertEnvironmentSchema('staging')).not.toThrow();
    expect(() => assertEnvironmentSchema('development')).not.toThrow();
    expect(() => assertEnvironmentSchema('public')).toThrow(/refusing to write to schema "public"/);
  });
});
