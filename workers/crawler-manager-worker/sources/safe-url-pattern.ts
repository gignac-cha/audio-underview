import isSafeRegex from 'safe-regex2';

export function isSafeURLPattern(pattern: string): boolean {
  return isSafeRegex(pattern);
}
