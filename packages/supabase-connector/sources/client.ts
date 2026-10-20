import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, SupabaseConnectorConfiguration } from './types/index.ts';

// Lowercase letters, digits and underscores, not starting with a digit: the schema names of this
// project (`public`, `staging`, `development`) and the form Postgres folds an unquoted name to
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Creates a Supabase client configured for server-side usage with secret key.
 * This client bypasses RLS and should only be used in secure server environments (Workers).
 *
 * @param configuration - Supabase URL, secret key and the Postgres schema to use
 * @returns Configured Supabase client
 * @throws Error when the schema is missing, empty or not a lowercase SQL identifier
 */
export function createSupabaseClient(
  configuration: SupabaseConnectorConfiguration
): SupabaseClient<Database> {
  // The type makes a call site pass a schema, but the value comes from a variable of the environment
  // that can be missing at run time. Without a schema the client sends no Accept-Profile or
  // Content-Profile header and PostgREST serves its first exposed schema, `public`, which is production.
  // So a bad value stops here instead of reaching the tables of another environment.
  if (typeof configuration.schema !== 'string' || !SCHEMA_NAME_PATTERN.test(configuration.schema)) {
    throw new Error(
      `Supabase schema must be a lowercase SQL identifier (letters, digits and underscores, not starting with a digit), received ${JSON.stringify(configuration.schema)}. Check the SUPABASE_SCHEMA variable of the environment.`
    );
  }

  return createClient<Database>(
    configuration.supabaseURL,
    configuration.supabaseSecretKey,
    {
      // supabase-js sends this as the Accept-Profile and Content-Profile headers, and PostgREST
      // puts only that schema on the search_path. The Database type describes `public`, but the
      // tables have the same shape in every schema, so the name is cast to fit the type.
      db: { schema: configuration.schema as 'public' },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

export type { SupabaseClient };
