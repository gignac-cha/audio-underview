import type { AuthenticatedUser } from '@audio-underview/schemas';
import { generateAuthorizationCode } from '../random.ts';

/**
 * 일회용 authorization code 저장소 (KV, TTL 60s, single-use).
 *
 * callback이 사용자 정보를 redirect URL에 싣는 대신 code만 전달하고,
 * 클라이언트가 `POST /tokens`로 교환한다 — 레거시의 "redirect 쿼리에
 * provider access_token 노출" 문제를 제거 (스펙 §10.2).
 */

export interface AuthorizationCodeRecord {
  user: AuthenticatedUser;
}

const AUTHORIZATION_CODE_TTL_SECONDS = 60;

const codeKey = (code: string): string => `authorization-code:${code}`;

export const createAuthorizationCode = async (
  kv: KVNamespace,
  record: AuthorizationCodeRecord,
): Promise<string> => {
  const code = generateAuthorizationCode();
  await kv.put(codeKey(code), JSON.stringify(record), {
    expirationTtl: AUTHORIZATION_CODE_TTL_SECONDS,
  });
  return code;
};

export const consumeAuthorizationCode = async (
  kv: KVNamespace,
  code: string,
): Promise<AuthorizationCodeRecord | undefined> => {
  const key = codeKey(code);
  const stored = await kv.get(key);
  if (stored === null) {
    return undefined;
  }
  await kv.delete(key);

  try {
    return JSON.parse(stored) as AuthorizationCodeRecord;
  } catch {
    return undefined;
  }
};
