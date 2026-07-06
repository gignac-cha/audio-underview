import type { AuthenticatedUser } from '@audio-underview/schemas';
import { generateRefreshToken } from '../random.ts';

/**
 * Rotating refresh token 저장소 (KV, TTL 30일).
 *
 * - 토큰은 불투명 랜덤 문자열, 사용(rotate) 시 consumed로 표시되고 새 토큰 발급.
 * - **재사용 감지**: consumed 토큰이 다시 제시되면 탈취로 간주하고
 *   해당 family(로그인 세션 계열) 전체를 폐기한다.
 * - 레거시는 refresh 개념 자체가 없었다 (스펙 §8 — 만료 시 재로그인만).
 */

export interface RefreshTokenRecord {
  user: AuthenticatedUser;
  familyID: string;
  status: 'active' | 'consumed';
}

interface FamilyRecord {
  activeToken: string;
}

const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const tokenKey = (token: string): string => `refresh-token:${token}`;
const familyKey = (familyID: string): string => `refresh-family:${familyID}`;

const putToken = (kv: KVNamespace, token: string, record: RefreshTokenRecord): Promise<void> =>
  kv.put(tokenKey(token), JSON.stringify(record), { expirationTtl: REFRESH_TOKEN_TTL_SECONDS });

const putFamily = (kv: KVNamespace, familyID: string, record: FamilyRecord): Promise<void> =>
  kv.put(familyKey(familyID), JSON.stringify(record), {
    expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
  });

const readJSON = async <Value>(kv: KVNamespace, key: string): Promise<Value | undefined> => {
  const stored = await kv.get(key);
  if (stored === null) {
    return undefined;
  }
  try {
    return JSON.parse(stored) as Value;
  } catch {
    return undefined;
  }
};

/** 로그인 시 새 family로 refresh token 발급. */
export const issueRefreshToken = async (
  kv: KVNamespace,
  user: AuthenticatedUser,
): Promise<string> => {
  const token = generateRefreshToken();
  const familyID = generateRefreshToken(32);
  await putToken(kv, token, { user, familyID, status: 'active' });
  await putFamily(kv, familyID, { activeToken: token });
  return token;
};

export type RotationResult =
  | { outcome: 'rotated'; user: AuthenticatedUser; refreshToken: string }
  | { outcome: 'invalid' }
  | { outcome: 'reuse_detected' };

/**
 * refresh token 사용: 기존 토큰을 consumed 처리하고 같은 family의 새 토큰 발급.
 * consumed 토큰 재제시 → family 폐기 후 `reuse_detected`.
 */
export const rotateRefreshToken = async (
  kv: KVNamespace,
  token: string,
): Promise<RotationResult> => {
  const record = await readJSON<RefreshTokenRecord>(kv, tokenKey(token));
  if (record === undefined) {
    return { outcome: 'invalid' };
  }

  if (record.status === 'consumed') {
    await revokeFamily(kv, record.familyID);
    await kv.delete(tokenKey(token));
    return { outcome: 'reuse_detected' };
  }

  await putToken(kv, token, { ...record, status: 'consumed' });

  const nextToken = generateRefreshToken();
  await putToken(kv, nextToken, { user: record.user, familyID: record.familyID, status: 'active' });
  await putFamily(kv, record.familyID, { activeToken: nextToken });

  return { outcome: 'rotated', user: record.user, refreshToken: nextToken };
};

export const revokeFamily = async (kv: KVNamespace, familyID: string): Promise<void> => {
  const family = await readJSON<FamilyRecord>(kv, familyKey(familyID));
  if (family !== undefined) {
    await kv.delete(tokenKey(family.activeToken));
  }
  await kv.delete(familyKey(familyID));
};
