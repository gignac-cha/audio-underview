import type { OAuthProviderID } from '@audio-underview/schemas';
import { generateState } from '../random.ts';

/**
 * OAuth state 저장소 (KV, TTL 300s, single-use).
 *
 * 레거시와 달리 (1) 값이 항상 JSON envelope이고 (2) 키가 provider로
 * namespace되며 (3) PKCE code_verifier를 운반한다 (스펙 §10.4, §10.12).
 */

export interface OAuthStateRecord {
  provider: OAuthProviderID;
  redirectURI: string;
  nonce?: string;
  codeVerifier?: string;
}

const STATE_TTL_SECONDS = 300;

const stateKey = (provider: OAuthProviderID, state: string): string =>
  `state:${provider}:${state}`;

export const createOAuthState = async (
  kv: KVNamespace,
  record: OAuthStateRecord,
): Promise<string> => {
  const state = generateState();
  await kv.put(stateKey(record.provider, state), JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  return state;
};

/**
 * state 검증 + 소비 (single-use — 조회 즉시 삭제).
 * 미존재/만료/JSON 파손이면 undefined.
 */
export const consumeOAuthState = async (
  kv: KVNamespace,
  provider: OAuthProviderID,
  state: string,
): Promise<OAuthStateRecord | undefined> => {
  const key = stateKey(provider, state);
  const stored = await kv.get(key);
  if (stored === null) {
    return undefined;
  }
  await kv.delete(key);

  try {
    return JSON.parse(stored) as OAuthStateRecord;
  } catch {
    return undefined;
  }
};
