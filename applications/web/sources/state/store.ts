import { createStore } from 'jotai';
import { readStoredSession, sessionAtom } from './session.ts';
import { readInitialTheme, themeAtom } from './theme.ts';

export type ApplicationStore = ReturnType<typeof createStore>;

/** 세션/테마를 localStorage에서 복원한 상태의 store를 만든다 (앱/테스트 공용 팩토리). */
export const createApplicationStore = (): ApplicationStore => {
  const store = createStore();
  const storedSession = readStoredSession();
  if (storedSession !== null) {
    store.set(sessionAtom, storedSession);
  }
  store.set(themeAtom, readInitialTheme());
  return store;
};
