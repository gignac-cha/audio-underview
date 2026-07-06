import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types/database.ts';

export interface DatabaseConnectorOptions {
  supabaseURL: string;
  /**
   * Service-role secret key — RLS를 bypass하므로 **서버 환경(worker/function) 전용**.
   * 사용자 격리는 이 패키지의 repository 함수들이 `user_uuid` 조건으로 강제한다.
   */
  supabaseSecretKey: string;
}

export type DatabaseClient = SupabaseClient<Database>;

export const createDatabaseClient = (options: DatabaseConnectorOptions): DatabaseClient =>
  createClient<Database>(options.supabaseURL, options.supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
