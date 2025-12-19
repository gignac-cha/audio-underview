import { z } from 'zod';

export const environmentSchema = z.object({
  VITE_GOOGLE_CLIENT_ID: z.string().min(1, 'VITE_GOOGLE_CLIENT_ID is required'),
  VITE_GITHUB_OAUTH_WORKER_URL: z.string().url().optional(),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(): Environment {
  const result = environmentSchema.safeParse({
    VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID,
    VITE_GITHUB_OAUTH_WORKER_URL: import.meta.env.VITE_GITHUB_OAUTH_WORKER_URL,
  });

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Environment validation failed:\n${errors}`);
  }

  return result.data;
}

export function getEnvironment(): Environment {
  return {
    VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
    VITE_GITHUB_OAUTH_WORKER_URL: import.meta.env.VITE_GITHUB_OAUTH_WORKER_URL,
  };
}
