import {
  saveAuthenticationData,
  loadAuthenticationData,
  clearAuthenticationData,
  hasValidAuthentication,
} from './storage.ts';
import type { StoredAuthenticationData } from '../types/index.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mockLocalStorage = {
  store: {} as Record<string, string>,
  getItem: vi.fn((key: string) => mockLocalStorage.store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockLocalStorage.store[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockLocalStorage.store[key];
  }),
};

function setupLocalStorage() {
  mockLocalStorage.store = {};
  mockLocalStorage.getItem.mockClear();
  mockLocalStorage.setItem.mockClear();
  mockLocalStorage.removeItem.mockClear();
  vi.stubGlobal('localStorage', mockLocalStorage);
}

const validData: StoredAuthenticationData = {
  user: {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    provider: 'google',
  },
  credential: 'token-123',
  expiresAt: Date.now() + 60000,
};

describe('saveAuthenticationData', () => {
  test('saves data to localStorage', () => {
    setupLocalStorage();
    saveAuthenticationData(validData);

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
      'sign-provider-auth',
      JSON.stringify(validData),
    );
  });

  test('uses custom storage key', () => {
    setupLocalStorage();
    saveAuthenticationData(validData, 'custom-key');

    expect(mockLocalStorage.setItem).toHaveBeenCalledWith('custom-key', JSON.stringify(validData));
  });
});

describe('loadAuthenticationData', () => {
  test('loads valid non-expired data', () => {
    setupLocalStorage();
    mockLocalStorage.store['sign-provider-auth'] = JSON.stringify(validData);

    const result = loadAuthenticationData();
    expect(result).not.toBeNull();
    expect(result!.user.id).toBe('user-1');
  });

  test('returns null when no data exists', () => {
    setupLocalStorage();
    expect(loadAuthenticationData()).toBeNull();
  });

  test('removes and returns null for expired data', () => {
    setupLocalStorage();
    const expiredData = { ...validData, expiresAt: Date.now() - 1000 };
    mockLocalStorage.store['sign-provider-auth'] = JSON.stringify(expiredData);

    expect(loadAuthenticationData()).toBeNull();
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('sign-provider-auth');
  });

  test('removes and returns null for invalid JSON', () => {
    setupLocalStorage();
    mockLocalStorage.store['sign-provider-auth'] = 'not-json{{{';

    expect(loadAuthenticationData()).toBeNull();
    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('sign-provider-auth');
  });
});

describe('clearAuthenticationData', () => {
  test('removes data from localStorage', () => {
    setupLocalStorage();
    clearAuthenticationData();

    expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('sign-provider-auth');
  });
});

describe('hasValidAuthentication', () => {
  test('returns true when valid data exists', () => {
    setupLocalStorage();
    mockLocalStorage.store['sign-provider-auth'] = JSON.stringify(validData);

    expect(hasValidAuthentication()).toBe(true);
  });

  test('returns false when no data exists', () => {
    setupLocalStorage();
    expect(hasValidAuthentication()).toBe(false);
  });
});
