import type { StoredAuthenticationData } from '../types/index.ts';
import { parseStoredAuthenticationData, isAuthenticationExpired } from '../types/index.ts';

const DEFAULT_STORAGE_KEY = 'sign-provider-auth';

/**
 * Save authentication data to storage
 */
export function saveAuthenticationData(
  data: StoredAuthenticationData,
  storageKey: string = DEFAULT_STORAGE_KEY
): void {
  localStorage.setItem(storageKey, JSON.stringify(data));
}

/**
 * Load authentication data from storage
 * Returns null if data is invalid, expired, or doesn't exist
 */
export function loadAuthenticationData(
  storageKey: string = DEFAULT_STORAGE_KEY
): StoredAuthenticationData | null {
  const storedData = localStorage.getItem(storageKey);
  if (!storedData) {
    return null;
  }

  try {
    const parsed = JSON.parse(storedData);
    const validatedData = parseStoredAuthenticationData(parsed);

    if (validatedData && !isAuthenticationExpired(validatedData)) {
      return validatedData;
    }

    // Data is expired, remove it
    localStorage.removeItem(storageKey);
    return null;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
}

/**
 * Clear authentication data from storage
 */
export function clearAuthenticationData(storageKey: string = DEFAULT_STORAGE_KEY): void {
  localStorage.removeItem(storageKey);
}

/**
 * Check if user is authenticated (has valid, non-expired data in storage)
 */
export function hasValidAuthentication(storageKey: string = DEFAULT_STORAGE_KEY): boolean {
  return loadAuthenticationData(storageKey) !== null;
}
