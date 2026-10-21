import { describe, it, expect } from 'vitest';

// The tests of this worker sit next to its sources. They are left out: they are not deployed, and they
// reach the client only through storage.ts.
const sources = import.meta.glob<string>(['../sources/**/*.ts', '!../sources/**/*.test.ts'], { query: '?raw', import: 'default', eager: true });

// The types make a call site pass a schema; this keeps it the one of the environment, because a fixed
// one would send the requests of staging or development to the tables of production.
//
// Every call has to be one this test reads and approves. A call it cannot read (a variable as the
// argument, braces inside the argument) is counted but not inspected, so the counts differ and the test fails.

// An import statement names the function without calling it
const IMPORT_STATEMENTS = /^import\b[^;]*?\bfrom\s*['"][^'"]+['"];?/gm;
// Under another name the calls would be invisible to the counts below, which look for the name of the function
const ALIASED_IMPORTS = /\bcreateSupabaseClient['"]?(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)+as\b/;
// A definition is not a call either (the function lives in the connector, but a copy would be one)
const MENTIONS = /(?<!\bfunction\s+)\bcreateSupabaseClient\b/g;
const CALLS = /(?<!\bfunction\s+)\bcreateSupabaseClient\s*\(/g;
const READABLE_CALLS = /createSupabaseClient\(\{[^}]*\}\)/g;
const SCHEMA_OF_ENVIRONMENT = /\bschema: environment\.SUPABASE_SCHEMA,/;
// A spread can carry a schema of its own, and a later key wins over an earlier one
const SPREADS = /\.\.\./;
// supabase-js builds a client without the connector, so without the schema. Its types are harmless:
// `import type`, or braces holding nothing but `type` specifiers.
const SUPABASE_JS_SPECIFIERS = /['"`]@supabase\/supabase-js(?:\/[^'"`]*)?['"`]/;
const TYPE_ONLY_IMPORTS_OF_SUPABASE_JS =
  /^import\s+(?:type\s+(?!from\s*['"])[^;'"]*?|\{\s*(?:type\s+(?!as\b)[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\})\s*from\s*['"]@supabase\/supabase-js(?:\/[^'"]*)?['"];?/gm;

describe('createSupabaseClient call sites', () => {
  const codes = Object.entries(sources).map(([path, text]) => ({ path, code: text.replace(IMPORT_STATEMENTS, '') }));
  const mentions = codes.flatMap(({ code }) => [...code.matchAll(MENTIONS)]);
  const calls = codes.flatMap(({ code }) => [...code.matchAll(CALLS)]);
  const inspected = codes.flatMap(({ path, code }) => [...code.matchAll(READABLE_CALLS)].map((match) => ({ path, call: match[0] })));
  const approved = inspected.filter(({ call }) => SCHEMA_OF_ENVIRONMENT.test(call) && !SPREADS.test(call));
  const aliased = Object.entries(sources)
    .filter(([, text]) => [...text.matchAll(IMPORT_STATEMENTS)].some(([statement]) => ALIASED_IMPORTS.test(statement)))
    .map(([path]) => path);

  it('are found in the sources', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('are the only way the sources use the function', () => {
    expect(mentions.length).toBe(calls.length);
  });

  it('are never made through an import under another name', () => {
    expect(aliased).toEqual([]);
  });

  it('are all inspected, however the argument is written', () => {
    expect(inspected.length).toBe(calls.length);
  });

  it('are all approved', () => {
    expect(approved.length).toBe(calls.length);
  });

  it.each(inspected.map(({ path, call }, index) => [`${path} #${index + 1}`, call] as const))('%s passes the schema of the environment', (_name, call) => {
    expect(call).toMatch(SCHEMA_OF_ENVIRONMENT);
    expect(call).not.toMatch(SPREADS);
  });
});

describe('supabase-js in the sources', () => {
  const importing = Object.entries(sources)
    .filter(([, text]) => SUPABASE_JS_SPECIFIERS.test(text.replace(TYPE_ONLY_IMPORTS_OF_SUPABASE_JS, '')))
    .map(([path]) => path);

  it('is only imported for its types, so every client comes from the connector', () => {
    expect(importing).toEqual([]);
  });
});
