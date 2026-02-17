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
  uuid: string;
}

/**
 * Account table row type
 * Represents a social login account linked to a user
 */
export interface AccountRow {
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
 * Crawler table row type
 * Represents a user-defined crawler with code to process matched URLs
 */
export interface CrawlerRow {
  id: string;
  user_uuid: string;
  name: string;
  url_pattern: string;
  code: string;
  created_at: string;
  updated_at: string;
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
        Insert: { uuid?: string };
        Update: Partial<UserRow>;
        Relationships: [];
      };
      accounts: {
        Row: AccountRow;
        Insert: {
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
          id?: string;
          user_uuid: string;
          name: string;
          url_pattern: string;
          code: string;
        };
        Update: Partial<CrawlerRow>;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      provider_type: ProviderType;
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
