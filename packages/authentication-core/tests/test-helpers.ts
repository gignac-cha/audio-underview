import type { AuthenticatedUser } from '@audio-underview/schemas';

/** 테스트용 in-memory KVNamespace (TTL 무시 — 로직 검증 목적). */
export const createFakeKV = (): KVNamespace & { entries: Map<string, string> } => {
  const entries = new Map<string, string>();
  const fake = {
    entries,
    get: (key: string) => Promise.resolve(entries.get(key) ?? null),
    put: (key: string, value: string) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
  return fake as unknown as KVNamespace & { entries: Map<string, string> };
};

export const testUser: AuthenticatedUser = {
  id: 'provider-user-1',
  email: 'user@example.com',
  name: 'Test User',
  provider: 'google',
  uuid: '00000000-0000-4000-8000-000000000001',
};
