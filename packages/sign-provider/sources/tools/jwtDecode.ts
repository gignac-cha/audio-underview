/**
 * Simple JWT decoder without signature verification.
 * This is safe for client-side use where the server has already verified the token.
 */
export function jwtDecode<T = Record<string, unknown>>(token: string): T {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT token format');
  }

  const payload = parts[1];
  if (!payload) {
    throw new Error('Invalid JWT payload');
  }

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    throw new Error('Failed to decode JWT payload');
  }
}

/**
 * Get JWT expiration time
 */
export function getJWTExpiration(token: string): number | null {
  try {
    const decoded = jwtDecode<{ exp?: number }>(token);
    return decoded.exp ? decoded.exp * 1000 : null; // Convert to milliseconds
  } catch {
    return null;
  }
}

/**
 * Check if JWT is expired
 */
export function isJWTExpired(token: string): boolean {
  const expiration = getJWTExpiration(token);
  if (expiration === null) {
    return false; // No expiration claim, assume valid
  }
  return expiration <= Date.now();
}
