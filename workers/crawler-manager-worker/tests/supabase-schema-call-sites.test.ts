import { describe, it, expect } from 'vitest';

const sources = import.meta.glob<string>('../sources/**/*.ts', { query: '?raw', import: 'default', eager: true });

// The types make a call site pass a schema; this keeps it the one of the environment, because a fixed
// one would send the requests of staging or development to the tables of production.
//
// Every call has to be one this test reads and approves. A call it cannot read (a variable as the
// argument, braces inside the argument) is counted but not inspected, so the counts differ and the test fails.

// An import statement names the function without calling it
const IMPORT_STATEMENTS = /^import\b[^;]*?\bfrom\s*['"][^'"]+['"];?/gm;
// A definition is not a call either (the function lives in the connector, but a copy would be one)
const MENTIONS = /(?<!\bfunction\s+)\bcreateSupabaseClient\b/g;
const CALLS = /(?<!\bfunction\s+)\bcreateSupabaseClient\s*\(/g;
const READABLE_CALLS = /createSupabaseClient\(\{[^}]*\}\)/g;
const SCHEMA_OF_ENVIRONMENT = /\bschema: environment\.SUPABASE_SCHEMA,/;

describe('createSupabaseClient call sites', () => {
  const codes = Object.entries(sources).map(([path, text]) => ({ path, code: text.replace(IMPORT_STATEMENTS, '') }));
  const mentions = codes.flatMap(({ code }) => [...code.matchAll(MENTIONS)]);
  const calls = codes.flatMap(({ code }) => [...code.matchAll(CALLS)]);
  const inspected = codes.flatMap(({ path, code }) => [...code.matchAll(READABLE_CALLS)].map((match) => ({ path, call: match[0] })));
  const approved = inspected.filter(({ call }) => SCHEMA_OF_ENVIRONMENT.test(call));

  it('are found in the sources', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  it('are the only way the sources use the function', () => {
    expect(mentions.length).toBe(calls.length);
  });

  it('are all inspected, however the argument is written', () => {
    expect(inspected.length).toBe(calls.length);
  });

  it('are all approved', () => {
    expect(approved.length).toBe(calls.length);
  });

  it.each(inspected.map(({ path, call }, index) => [`${path} #${index + 1}`, call] as const))('%s passes the schema of the environment', (_name, call) => {
    expect(call).toMatch(SCHEMA_OF_ENVIRONMENT);
  });
});
