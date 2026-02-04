import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, SupabaseConnectorConfiguration } from './types/index.ts';

/**
 * Creates a Supabase client configured for server-side usage with secret key.
 * This client bypasses RLS and should only be used in secure server environments (Workers).
 *
 * @param configuration - Supabase URL and secret key
 * @returns Configured Supabase client
 */
export function createSupabaseClient(
  configuration: SupabaseConnectorConfiguration
): SupabaseClient<Database> {
  return createClient<Database>(
    configuration.supabaseURL,
    configuration.supabaseSecretKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}

export type { SupabaseClient };
