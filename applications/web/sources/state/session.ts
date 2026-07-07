import { authenticatedUserSchema, type AuthenticatedUser } from '@audio-underview/schemas';
import { atom } from 'jotai';
import { z } from 'zod';

/**
 * 세션 단일 소스 — access/refresh 토큰과 사용자 정보를 하나의 atom으로 관리한다.
 * (레거시 개선 §10.7: localStorage를 렌더 중 직접 읽던 비반응성 제거)
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  /** access token 만료 시각 (epoch milliseconds) */
  expiresAt: number;
  user: AuthenticatedUser;
}

export const SESSION_STORAGE_KEY = 'audio-underview:session';

const storedSessionSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  user: authenticatedUserSchema,
});

/**
 * localStorage에서 세션 복원. 파손된 데이터는 즉시 제거한다.
 * access token이 만료되어 있어도 refresh token으로 갱신할 수 있으므로 세션은 유지한다.
 */
export const readStoredSession = (): StoredSession | null => {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = storedSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed.data;
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
};

const baseSessionAtom = atom<StoredSession | null>(null);

/** 쓰기 시 localStorage 동기화까지 담당하는 세션 atom */
export const sessionAtom = atom(
  (get) => get(baseSessionAtom),
  (_get, set, next: StoredSession | null) => {
    set(baseSessionAtom, next);
    try {
      if (next === null) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } else {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(next));
      }
    } catch {
      // 스토리지 실패(사파리 프라이빗 모드 등)는 메모리 세션만으로 진행
    }
  },
);

export const authenticatedUserAtom = atom((get) => get(sessionAtom)?.user ?? null);
export const isAuthenticatedAtom = atom((get) => get(sessionAtom) !== null);
