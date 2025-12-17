import { z } from 'zod';

export const googleUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  name: z.string().min(1, 'Name is required'),
  picture: z.string().url('Invalid picture URL'),
  sub: z.string().min(1, 'Subject (sub) is required'),
});

export type GoogleUser = z.infer<typeof googleUserSchema>;

export const storedAuthDataSchema = z.object({
  user: googleUserSchema,
  credential: z.string().min(1),
  expiresAt: z.number().positive(),
});

export type StoredAuthData = z.infer<typeof storedAuthDataSchema>;

export function parseGoogleUser(decoded: unknown): GoogleUser {
  const result = googleUserSchema.safeParse(decoded);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Invalid Google user data: ${errors}`);
  }

  return result.data;
}

export function parseStoredAuthData(data: unknown): StoredAuthData | null {
  const result = storedAuthDataSchema.safeParse(data);
  return result.success ? result.data : null;
}
