import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom implements neither media playback nor scroll, and both are exercised by
 * the components under test. Stubbing them here keeps every test file free of
 * boilerplate, and makes `play` / `pause` / `scrollIntoView` spy-able where a
 * test actually cares.
 */
Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: vi.fn().mockResolvedValue(undefined),
});

Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(window.Element.prototype, 'scrollIntoView', {
  configurable: true,
  writable: true,
  value: vi.fn(),
});

/**
 * jsdom's `duration` is always NaN and `currentTime` is read-only-ish; the
 * viewer both reads and writes them, so back them with a plain value.
 */
Object.defineProperty(window.HTMLMediaElement.prototype, 'currentTime', {
  configurable: true,
  get(this: HTMLMediaElement & { currentTimeValue?: number }) {
    return this.currentTimeValue ?? 0;
  },
  set(this: HTMLMediaElement & { currentTimeValue?: number }, value: number) {
    this.currentTimeValue = value;
  },
});

/**
 * Node 26 ships its own experimental `localStorage` global, which is `undefined`
 * unless the process was started with `--localstorage-file`. Vitest's jsdom
 * environment skips copying jsdom's implementation over an already-present
 * global, so the page's one persisted key would have nowhere to live. An
 * in-memory Storage restores the browser behaviour the code is written against.
 */
if (window.localStorage === undefined || window.localStorage === null) {
  const entries = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: memoryStorage,
  });
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
