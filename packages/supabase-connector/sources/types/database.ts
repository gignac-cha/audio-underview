import type { OAuthProviderID } from '@audio-underview/sign-provider';

/**
 * Provider type enum matching the database enum
 * Currently supporting: google, github (with room for expansion)
 */
export type ProviderType = OAuthProviderID;

/**
 * User table row type
 * Represents an integrated account that can have multiple social login accounts
 */
export interface UserRow {
  [key: string]: unknown;
  uuid: string;
}

/**
 * Account table row type
 * Represents a social login account linked to a user
 */
export interface AccountRow {
  [key: string]: unknown;
  provider: ProviderType;
  identifier: string;
  uuid: string;
}

/**
 * Input for creating or finding a user via social login
 */
export interface SocialLoginInput {
  provider: ProviderType;
  identifier: string;
}

/**
 * Result of a social login operation
 */
export interface SocialLoginResult {
  userUUID: string;
  isNewUser: boolean;
  isNewAccount: boolean;
}

/**
 * Result of linking an additional account to an existing user
 */
export interface LinkAccountResult {
  success: boolean;
  alreadyLinked: boolean;
}

/**
 * Crawler type enum matching the database enum
 */
export type CrawlerType = 'web' | 'data';

/**
 * Crawler table row type
 * Represents a user-defined crawler with code to process matched URLs
 */
export interface CrawlerRow {
  [key: string]: unknown;
  id: string;
  user_uuid: string;
  name: string;
  type: CrawlerType;
  url_pattern: string | null;
  code: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Scheduler table row type
 * Represents a pipeline that chains crawlers into sequential stages
 */
export interface SchedulerRow {
  [key: string]: unknown;
  id: string;
  user_uuid: string;
  name: string;
  cron_expression: string | null;
  is_enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Scheduler stage table row type
 * Represents a stage within a scheduler pipeline.
 * input_schema uses JSON Schema format with optional defaults
 * (e.g. { url: { type: "string", default: "https://..." } }).
 * output_schema is derived from the crawler's output_schema.
 * foreach_field names the array field in previous output to fan-out over.
 */
export interface SchedulerStageRow {
  [key: string]: unknown;
  id: string;
  scheduler_id: string;
  crawler_id: string;
  stage_order: number;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  foreach_field: string | null;
  created_at: string;
}

/**
 * Scheduler run status enum matching the database enum
 */
export type SchedulerRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partially_failed';

/**
 * Scheduler run table row type
 * Tracks top-level execution status for a scheduler pipeline (update-in-place)
 */
export interface SchedulerRunRow {
  [key: string]: unknown;
  id: string;
  scheduler_id: string;
  status: SchedulerRunStatus;
  started_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
}

/**
 * Scheduler stage run table row type
 * Per-stage execution record within a run, for debugging and UI display
 */
export interface SchedulerStageRunRow {
  [key: string]: unknown;
  id: string;
  run_id: string;
  stage_id: string;
  stage_order: number;
  status: SchedulerRunStatus;
  started_at: string | null;
  completed_at: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  items_total: number | null;
  items_succeeded: number | null;
  items_failed: number | null;
  created_at: string;
}

/**
 * Supabase connector configuration
 */
export interface SupabaseConnectorConfiguration {
  supabaseURL: string;
  supabaseSecretKey: string;
}

/**
 * Database schema type for Supabase client
 * Follows Supabase GenericSchema format
 */
export interface Database {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: { [key: string]: unknown; uuid?: string };
        Update: Partial<UserRow>;
        Relationships: [];
      };
      accounts: {
        Row: AccountRow;
        Insert: {
          [key: string]: unknown;
          provider: ProviderType;
          identifier: string;
          uuid: string;
        };
        Update: Partial<AccountRow>;
        Relationships: [
          {
            foreignKeyName: 'accounts_uuid_fkey';
            columns: ['uuid'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['uuid'];
          },
        ];
      };
      crawlers: {
        Row: CrawlerRow;
        Insert: {
          [key: string]: unknown;
          id?: string;
          user_uuid: string;
          name: string;
          type?: CrawlerType;
          url_pattern?: string | null;
          code: string;
          input_schema?: Record<string, unknown>;
          output_schema?: Record<string, unknown>;
        };
        Update: Partial<Omit<CrawlerRow, 'created_at' | 'updated_at'>>;
        Relationships: [
          {
            foreignKeyName: 'crawlers_user_uuid_fkey';
            columns: ['user_uuid'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['uuid'];
          },
        ];
      };
      schedulers: {
        Row: SchedulerRow;
        Insert: {
          [key: string]: unknown;
          id?: string;
          user_uuid: string;
          name: string;
          cron_expression?: string | null;
          is_enabled?: boolean;
        };
        Update: Partial<Omit<SchedulerRow, 'created_at' | 'updated_at'>>;
        Relationships: [
          {
            foreignKeyName: 'schedulers_user_uuid_fkey';
            columns: ['user_uuid'];
            isOneToOne: false;
            referencedRelation: 'users';
            referencedColumns: ['uuid'];
          },
        ];
      };
      scheduler_stages: {
        Row: SchedulerStageRow;
        Insert: {
          [key: string]: unknown;
          id?: string;
          scheduler_id: string;
          crawler_id: string;
          stage_order: number;
          input_schema: Record<string, unknown>;
          output_schema?: Record<string, unknown>;
          foreach_field?: string | null;
        };
        Update: Partial<Omit<SchedulerStageRow, 'id' | 'scheduler_id' | 'created_at'>>;
        Relationships: [
          {
            foreignKeyName: 'scheduler_stages_scheduler_id_fkey';
            columns: ['scheduler_id'];
            isOneToOne: false;
            referencedRelation: 'schedulers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'scheduler_stages_crawler_id_fkey';
            columns: ['crawler_id'];
            isOneToOne: false;
            referencedRelation: 'crawlers';
            referencedColumns: ['id'];
          },
        ];
      };
      scheduler_runs: {
        Row: SchedulerRunRow;
        Insert: {
          [key: string]: unknown;
          id?: string;
          scheduler_id: string;
          status?: SchedulerRunStatus;
          started_at?: string | null;
          completed_at?: string | null;
          result?: Record<string, unknown> | null;
          error?: string | null;
        };
        Update: Partial<Omit<SchedulerRunRow, 'id' | 'scheduler_id' | 'created_at'>>;
        Relationships: [
          {
            foreignKeyName: 'scheduler_runs_scheduler_id_fkey';
            columns: ['scheduler_id'];
            isOneToOne: false;
            referencedRelation: 'schedulers';
            referencedColumns: ['id'];
          },
        ];
      };
      scheduler_stage_runs: {
        Row: SchedulerStageRunRow;
        Insert: {
          [key: string]: unknown;
          id?: string;
          run_id: string;
          stage_id: string;
          stage_order: number;
          status?: SchedulerRunStatus;
          started_at?: string | null;
          completed_at?: string | null;
          input?: Record<string, unknown> | null;
          output?: Record<string, unknown> | null;
          error?: string | null;
          items_total?: number | null;
          items_succeeded?: number | null;
          items_failed?: number | null;
        };
        Update: Partial<Omit<SchedulerStageRunRow, 'id' | 'run_id' | 'stage_id' | 'created_at'>>;
        Relationships: [
          {
            foreignKeyName: 'scheduler_stage_runs_run_id_fkey';
            columns: ['run_id'];
            isOneToOne: false;
            referencedRelation: 'scheduler_runs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'scheduler_stage_runs_stage_id_fkey';
            columns: ['stage_id'];
            isOneToOne: false;
            referencedRelation: 'scheduler_stages';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<string, never>;
    Functions: {
      reorder_scheduler_stages: {
        Args: {
          p_scheduler_id: string;
          p_stage_ids: string[];
        };
        Returns: SchedulerStageRow[];
      };
    };
    Enums: {
      provider_type: ProviderType;
      crawler_type: CrawlerType;
      scheduler_run_status: SchedulerRunStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

/**
 * Type aliases for table insert types (extracted from Database)
 */
export type UsersInsert = Database['public']['Tables']['users']['Insert'];
export type AccountsInsert = Database['public']['Tables']['accounts']['Insert'];
export type CrawlersInsert = Database['public']['Tables']['crawlers']['Insert'];
export type CrawlersUpdate = Database['public']['Tables']['crawlers']['Update'];
export type SchedulersInsert = Database['public']['Tables']['schedulers']['Insert'];
export type SchedulersUpdate = Database['public']['Tables']['schedulers']['Update'];
export type SchedulerStagesInsert = Database['public']['Tables']['scheduler_stages']['Insert'];
export type SchedulerStagesUpdate = Database['public']['Tables']['scheduler_stages']['Update'];
export type SchedulerRunsInsert = Database['public']['Tables']['scheduler_runs']['Insert'];
export type SchedulerRunsUpdate = Database['public']['Tables']['scheduler_runs']['Update'];
export type SchedulerStageRunsInsert = Database['public']['Tables']['scheduler_stage_runs']['Insert'];
export type SchedulerStageRunsUpdate = Database['public']['Tables']['scheduler_stage_runs']['Update'];
