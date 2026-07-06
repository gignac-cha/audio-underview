import { parseEnvironment } from '@audio-underview/worker-foundation';
import { z } from 'zod';

/** wrangler가 주입하는 raw 환경 (vars + secrets) */
export interface WorkerEnvironment {
  ALLOWED_ORIGINS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  JWT_SECRET?: string;
  CODE_RUNNER_FUNCTION_URL?: string;
}

const environmentSchema = z.object({
  ALLOWED_ORIGINS: z.string().default(''),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  CODE_RUNNER_FUNCTION_URL: z.url(),
});

export type CrawlerManagerEnvironment = z.infer<typeof environmentSchema>;

export const parseCrawlerManagerEnvironment = (
  environment: WorkerEnvironment,
): CrawlerManagerEnvironment => parseEnvironment(environmentSchema, environment);
