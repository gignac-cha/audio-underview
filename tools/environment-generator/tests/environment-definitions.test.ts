import { describe, expect, test } from 'vitest';

import { SECRET_MAPPINGS, ENVIRONMENT_FILES } from '../sources/environment-definitions.ts';

describe('SECRET_MAPPINGS', () => {
  test('every reference points at the Audio Underview vault', () => {
    for (const mapping of SECRET_MAPPINGS) {
      expect(mapping.reference).toMatch(/^op:\/\/Audio Underview\//);
    }
  });

  test('variable names are unique', () => {
    const names = SECRET_MAPPINGS.map((mapping) => mapping.variableName);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('ENVIRONMENT_FILES', () => {
  test('every file variable has a secret mapping', () => {
    const mappedNames = new Set(SECRET_MAPPINGS.map((mapping) => mapping.variableName));

    for (const environmentFile of ENVIRONMENT_FILES) {
      for (const variableName of environmentFile.variableNames) {
        expect(mappedNames, `missing mapping for ${variableName}`).toContain(variableName);
      }
    }
  });

  test('every mapped variable is written to exactly one file', () => {
    const written = ENVIRONMENT_FILES.flatMap((environmentFile) => environmentFile.variableNames);
    expect(new Set(written).size).toBe(written.length);
    expect(written.length).toBe(SECRET_MAPPINGS.length);
  });

  test('output paths are the expected three files', () => {
    const paths = ENVIRONMENT_FILES.map((environmentFile) => environmentFile.outputPathSegments.join('/'));
    expect(paths).toStrictEqual(['applications/web/.env', '.env.workers', '.env.deploy']);
  });
});
