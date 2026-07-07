import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './mocks/server.ts';

// localStorage 구현은 실행 환경(jsdom, Node 24/25의 내장 Web Storage, Node 26)에 따라
// 존재 여부와 완전성이 제각각이다 — 어떤 Node/CI runner에서는 `clear`조차 없는 불완전한
// 전역이 주입된다. 조건부 폴리필은 이 차이에 취약하므로 **항상** 테스트 전용 인메모리
// 구현으로 덮어써 환경 간 일관성과 테스트 격리를 보장한다.
const localStorageStore = new Map<string, string>();
const inMemoryLocalStorage: Storage = {
  get length() {
    return localStorageStore.size;
  },
  clear: () => {
    localStorageStore.clear();
  },
  getItem: (key) => localStorageStore.get(key) ?? null,
  key: (index) => [...localStorageStore.keys()][index] ?? null,
  removeItem: (key) => {
    localStorageStore.delete(key);
  },
  setItem: (key, value) => {
    localStorageStore.set(key, value);
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: inMemoryLocalStorage,
  configurable: true,
});

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  localStorage.clear();
});

afterAll(() => {
  server.close();
});
