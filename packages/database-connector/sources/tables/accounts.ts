import type { OAuthProviderID } from '@audio-underview/schemas';
import type { DatabaseClient } from '../client.ts';
import { DatabaseOperationError, isNoRowsError } from '../errors.ts';
import type { AccountRow, UserRow } from '../types/database.ts';

export interface SocialLoginInput {
  provider: OAuthProviderID;
  identifier: string;
}

export interface SocialLoginResult {
  userUUID: string;
  isNewUser: boolean;
  isNewAccount: boolean;
}

export const findAccount = async (
  client: DatabaseClient,
  input: SocialLoginInput,
): Promise<AccountRow | undefined> => {
  const { data, error } = await client
    .from('accounts')
    .select('*')
    .eq('provider', input.provider)
    .eq('identifier', input.identifier)
    .single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('find', 'account', error);
  }
  return data;
};

export const findUser = async (
  client: DatabaseClient,
  userUUID: string,
): Promise<UserRow | undefined> => {
  const { data, error } = await client.from('users').select('*').eq('uuid', userUUID).single();

  if (error !== null) {
    if (isNoRowsError(error)) {
      return undefined;
    }
    throw new DatabaseOperationError('find', 'user', error);
  }
  return data;
};

/**
 * social login의 user+account 찾기/생성 — 트랜잭션 RPC (migration 009).
 * 레거시의 수동 rollback 2단계 쓰기를 대체한다.
 */
export const handleSocialLogin = async (
  client: DatabaseClient,
  input: SocialLoginInput,
): Promise<SocialLoginResult> => {
  const { data, error } = await client.rpc('social_login', {
    p_provider: input.provider,
    p_identifier: input.identifier,
  });

  if (error !== null) {
    throw new DatabaseOperationError('handle social login for', 'account', error);
  }

  const row = data[0];
  if (row === undefined) {
    throw new DatabaseOperationError('handle social login for', 'account', 'empty RPC result');
  }

  return {
    userUUID: row.user_uuid,
    isNewUser: row.is_new_user,
    isNewAccount: row.is_new_account,
  };
};
