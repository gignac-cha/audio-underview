import { parseEnvironment } from '@audio-underview/worker-foundation';
import { z } from 'zod';

/** wrangler가 주입하는 raw 환경 (vars + secrets + KV binding) */
export interface WorkerEnvironment {
  ALLOWED_ORIGINS?: string;
  FRONTEND_URL?: string;
  JWT_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  OAUTH_STATE?: KVNamespace;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT?: string;
  FACEBOOK_CLIENT_ID?: string;
  FACEBOOK_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  KAKAO_CLIENT_ID?: string;
  KAKAO_CLIENT_SECRET?: string;
  NAVER_CLIENT_ID?: string;
  NAVER_CLIENT_SECRET?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
}

const environmentSchema = z.object({
  ALLOWED_ORIGINS: z.string().default(''),
  FRONTEND_URL: z.url(),
  JWT_SECRET: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  OAUTH_STATE: z.custom<KVNamespace>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as KVNamespace).get === 'function',
    'OAUTH_STATE KV binding is required',
  ),
});

export type AuthenticationEnvironment = z.infer<typeof environmentSchema> & WorkerEnvironment;

export const parseAuthenticationEnvironment = (
  environment: WorkerEnvironment,
): AuthenticationEnvironment => ({
  ...environment,
  ...parseEnvironment(environmentSchema, environment),
});
