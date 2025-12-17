import { z } from 'zod';

/**
 * OAuth provider identifiers
 */
export const oauthProviderID = z.enum([
  'google',
  'apple',
  'microsoft',
  'facebook',
  'github',
  'x',
  'linkedin',
  'discord',
  'kakao',
  'naver',
]);

export type OAuthProviderID = z.infer<typeof oauthProviderID>;

/**
 * Standard OAuth user schema that all providers must conform to
 */
export const oauthUserSchema = z.object({
  id: z.string().min(1, 'User ID is required'),
  email: z.string().email('Invalid email format'),
  name: z.string().min(1, 'Name is required'),
  picture: z.string().url('Invalid picture URL').optional(),
  provider: oauthProviderID,
});

export type OAuthUser = z.infer<typeof oauthUserSchema>;

/**
 * Stored authentication data schema
 */
export const storedAuthenticationDataSchema = z.object({
  user: oauthUserSchema,
  credential: z.string().min(1),
  expiresAt: z.number().positive(),
});

export type StoredAuthenticationData = z.infer<typeof storedAuthenticationDataSchema>;

/**
 * Result of a login attempt
 */
export interface LoginResult {
  success: boolean;
  user?: OAuthUser;
  error?: string;
}

/**
 * Parse and validate OAuth user data
 */
export function parseOAuthUser(data: unknown): OAuthUser {
  const result = oauthUserSchema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid OAuth user data: ${errors}`);
  }

  return result.data;
}

/**
 * Parse and validate stored authentication data
 */
export function parseStoredAuthenticationData(data: unknown): StoredAuthenticationData | null {
  const result = storedAuthenticationDataSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Check if stored authentication data is expired
 */
export function isAuthenticationExpired(data: StoredAuthenticationData): boolean {
  return data.expiresAt <= Date.now();
}

/**
 * Create stored authentication data
 */
export function createStoredAuthenticationData(
  user: OAuthUser,
  credential: string,
  sessionDurationMilliseconds: number = 24 * 60 * 60 * 1000
): StoredAuthenticationData {
  return {
    user,
    credential,
    expiresAt: Date.now() + sessionDurationMilliseconds,
  };
}
