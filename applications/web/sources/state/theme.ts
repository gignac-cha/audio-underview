import { atom } from 'jotai';

export type ThemeName = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'audio-underview:theme';

const isThemeName = (value: unknown): value is ThemeName => value === 'light' || value === 'dark';

/** 저장된 선호 → 없으면 시스템 선호 */
export const readInitialTheme = (): ThemeName => {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeName(stored)) {
      return stored;
    }
  } catch {
    // 스토리지 접근 불가 시 시스템 선호로 폴백
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
};

const baseThemeAtom = atom<ThemeName>('dark');

/** 쓰기 시 <html data-theme> 반영 + localStorage 영속. Monaco 등도 이 atom을 구독한다. */
export const themeAtom = atom(
  (get) => get(baseThemeAtom),
  (_get, set, next: ThemeName) => {
    set(baseThemeAtom, next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 영속 실패는 무시 — 현재 세션에는 적용됨
    }
  },
);
