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
 * Supabase connector configuration
 */
export interface SupabaseConnectorConfiguration {
  supabaseURL: string;
  supabaseSecretKey: string;
}

/**
 * User table insert type (uuid is auto-generated)
 */
export interface UserInsert {
  uuid?: string;
}

/**
 * Account table insert type
 */
export interface AccountInsert {
  provider: ProviderType;
  identifier: string;
  uuid: string;
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
        Insert: UserInsert;
        Update: Partial<UserRow>;
        Relationships: [];
      };
      accounts: {
        Row: AccountRow;
        Insert: AccountInsert;
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
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      provider_type: ProviderType;
    };
    CompositeTypes: Record<string, never>;
  };
}
