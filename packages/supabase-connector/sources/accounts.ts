import type { SupabaseClient } from '@supabase/supabase-js';
import { traceDatabaseOperation, SpanStatusCode } from '@audio-underview/axiom-logger/tracers';
import type {
  Database,
  SocialLoginInput,
  SocialLoginResult,
  LinkAccountResult,
  AccountRow,
  UserRow,
  AccountsInsert,
  UsersInsert,
} from './types/index.ts';

type SupabaseClientType = SupabaseClient<Database>;

/**
 * Finds an existing account by provider and identifier.
 *
 * @param client - Supabase client
 * @param input - Provider type and identifier
 * @returns Account row if found, null otherwise
 */
export async function findAccount(
  client: SupabaseClientType,
  input: SocialLoginInput
): Promise<AccountRow | null> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'accounts' },
    async (span) => {
      span.setAttribute('db.query.provider', input.provider);

      const { data, error } = await client
        .from('accounts')
        .select('*')
        .eq('provider', input.provider)
        .eq('identifier', input.identifier)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return null;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to find account: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as AccountRow;
    }
  );
}

/**
 * Finds a user by UUID.
 *
 * @param client - Supabase client
 * @param userUUID - User UUID
 * @returns User row if found, null otherwise
 */
export async function findUser(
  client: SupabaseClientType,
  userUUID: string
): Promise<UserRow | null> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'users' },
    async (span) => {
      span.setAttribute('db.query.uuid', userUUID);

      const { data, error } = await client
        .from('users')
        .select('*')
        .eq('uuid', userUUID)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          span.setAttribute('db.rows_affected', 0);
          return null;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to find user: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as UserRow;
    }
  );
}

/**
 * Gets all accounts linked to a user.
 *
 * @param client - Supabase client
 * @param userUUID - User UUID
 * @returns Array of account rows
 */
export async function getAccountsByUser(
  client: SupabaseClientType,
  userUUID: string
): Promise<AccountRow[]> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'select', table: 'accounts' },
    async (span) => {
      span.setAttribute('db.query.uuid', userUUID);

      const { data, error } = await client
        .from('accounts')
        .select('*')
        .eq('uuid', userUUID);

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to get accounts: ${error.message}`);
      }

      const accounts = (data ?? []) as AccountRow[];
      span.setAttribute('db.rows_affected', accounts.length);
      return accounts;
    }
  );
}

/**
 * Creates a new user record.
 *
 * @param client - Supabase client
 * @returns Created user row with UUID
 */
export async function createUser(
  client: SupabaseClientType
): Promise<UserRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'users' },
    async (span) => {
      const insertData: UsersInsert = {};

      const { data, error } = await client
        .from('users')
        .insert(insertData as never)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create user: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      span.setAttribute('db.created_uuid', (data as UserRow).uuid);
      return data as UserRow;
    }
  );
}

/**
 * Creates a new account linked to a user.
 *
 * @param client - Supabase client
 * @param input - Provider, identifier, and user UUID
 * @returns Created account row
 */
export async function createAccount(
  client: SupabaseClientType,
  input: SocialLoginInput & { userUUID: string }
): Promise<AccountRow> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'insert', table: 'accounts' },
    async (span) => {
      span.setAttribute('db.insert.provider', input.provider);
      span.setAttribute('db.insert.uuid', input.userUUID);

      const insertData: AccountsInsert = {
        provider: input.provider,
        identifier: input.identifier,
        uuid: input.userUUID,
      };

      const { data, error } = await client
        .from('accounts')
        .insert(insertData as never)
        .select()
        .single();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to create account: ${error.message}`);
      }

      span.setAttribute('db.rows_affected', 1);
      return data as AccountRow;
    }
  );
}

/**
 * Handles social login flow:
 * - If account exists: returns existing user UUID
 * - If account doesn't exist: creates new user and account
 *
 * @param client - Supabase client
 * @param input - Provider type and identifier
 * @returns Social login result with user UUID and creation flags
 */
export async function handleSocialLogin(
  client: SupabaseClientType,
  input: SocialLoginInput
): Promise<SocialLoginResult> {
  // Check if account already exists
  const existingAccount = await findAccount(client, input);

  if (existingAccount) {
    return {
      userUUID: existingAccount.uuid,
      isNewUser: false,
      isNewAccount: false,
    };
  }

  // Create new user and account atomically (with rollback on failure)
  const newUser = await createUser(client);

  try {
    await createAccount(client, {
      ...input,
      userUUID: newUser.uuid,
    });
  } catch (accountError) {
    // Rollback: delete the newly created user to avoid orphaned records
    try {
      await deleteUser(client, newUser.uuid);
    } catch (rollbackError) {
      // Log rollback failure but throw the original error
      const originalMessage =
        accountError instanceof Error ? accountError.message : String(accountError);
      const rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `Failed to create account: ${originalMessage}. ` +
          `Additionally, rollback failed: ${rollbackMessage}. ` +
          `Orphaned user UUID: ${newUser.uuid}`
      );
    }
    throw accountError;
  }

  return {
    userUUID: newUser.uuid,
    isNewUser: true,
    isNewAccount: true,
  };
}

/**
 * Links an additional social account to an existing user.
 * Used when a logged-in user wants to connect another provider.
 *
 * @param client - Supabase client
 * @param userUUID - Existing user UUID
 * @param input - Provider type and identifier to link
 * @returns Link result with success and already-linked flags
 */
export async function linkAccount(
  client: SupabaseClientType,
  userUUID: string,
  input: SocialLoginInput
): Promise<LinkAccountResult> {
  // Check if this provider/identifier is already linked to any user
  const existingAccount = await findAccount(client, input);

  if (existingAccount) {
    if (existingAccount.uuid === userUUID) {
      // Already linked to this user
      return {
        success: true,
        alreadyLinked: true,
      };
    }
    // Linked to a different user - cannot link
    throw new Error(
      `This ${input.provider} account is already linked to another user`
    );
  }

  // Verify the user exists
  const user = await findUser(client, userUUID);
  if (!user) {
    throw new Error(`User not found: ${userUUID}`);
  }

  // Create the account link
  await createAccount(client, {
    ...input,
    userUUID,
  });

  return {
    success: true,
    alreadyLinked: false,
  };
}

/**
 * Unlinks a social account from a user.
 * Prevents unlinking the last account.
 *
 * @param client - Supabase client
 * @param userUUID - User UUID
 * @param input - Provider type and identifier to unlink
 * @returns True if unlinked successfully
 */
export async function unlinkAccount(
  client: SupabaseClientType,
  userUUID: string,
  input: SocialLoginInput
): Promise<boolean> {
  // Get all accounts for this user
  const accounts = await getAccountsByUser(client, userUUID);

  if (accounts.length <= 1) {
    throw new Error('Cannot unlink the last account');
  }

  // Verify the account belongs to this user
  const accountToUnlink = accounts.find(
    (account) =>
      account.provider === input.provider &&
      account.identifier === input.identifier
  );

  if (!accountToUnlink) {
    throw new Error('Account not found or does not belong to this user');
  }

  // Delete the account
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'accounts' },
    async (span) => {
      span.setAttribute('db.delete.provider', input.provider);
      span.setAttribute('db.delete.uuid', userUUID);

      const { data, error } = await client
        .from('accounts')
        .delete()
        .eq('provider', input.provider)
        .eq('identifier', input.identifier)
        .eq('uuid', userUUID)
        .select();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to unlink account: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);
      return rowsAffected > 0;
    }
  );
}

/**
 * Deletes a user and all linked accounts.
 *
 * @param client - Supabase client
 * @param userUUID - User UUID to delete
 * @returns True if deleted successfully
 */
export async function deleteUser(
  client: SupabaseClientType,
  userUUID: string
): Promise<boolean> {
  return traceDatabaseOperation(
    { serviceName: 'supabase-connector', operation: 'delete', table: 'users' },
    async (span) => {
      span.setAttribute('db.delete.uuid', userUUID);

      // Accounts will be deleted via CASCADE
      const { data, error } = await client
        .from('users')
        .delete()
        .eq('uuid', userUUID)
        .select();

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw new Error(`Failed to delete user: ${error.message}`);
      }

      const rowsAffected = data?.length ?? 0;
      span.setAttribute('db.rows_affected', rowsAffected);

      if (rowsAffected === 0) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'User not found' });
        throw new Error(`User not found: ${userUUID}`);
      }

      return true;
    }
  );
}
