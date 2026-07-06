import isSafeRegularExpression from 'safe-regex2';

/**
 * `url_pattern`의 ReDoS 안전성 검사 (safe-regex2).
 * - 생성/수정 시: 불합격이면 400 거부 (hard check)
 * - 실행 시: 불합격이면 URL 매칭 검증만 skip + warn (soft check — 스펙 §3.3)
 */
export const isSafeURLPattern = (pattern: string): boolean => {
  try {
    return isSafeRegularExpression(pattern);
  } catch {
    return false;
  }
};
