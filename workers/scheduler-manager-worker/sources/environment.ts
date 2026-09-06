import { parseEnvironment } from '@audio-underview/worker-foundation';
import { z } from 'zod';

/** crawler-manager Service Binding 표면 (스펙 §3.4) */
export interface CrawlerManagerBinding {
  executeCrawler(crawlerID: string, input: unknown): Promise<unknown>;
}

/** wrangler가 주입하는 raw 환경 (vars + secrets + bindings) */
export interface WorkerEnvironment {
  ALLOWED_ORIGINS?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  JWT_SECRET?: string;
  SCHEDULED_EXECUTION_ENABLED?: string;
  CRAWLER_MANAGER?: CrawlerManagerBinding;
}

const environmentSchema = z.object({
  ALLOWED_ORIGINS: z.string().default(''),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  SCHEDULED_EXECUTION_ENABLED: z.string().default('false'),
  CRAWLER_MANAGER: z.custom<CrawlerManagerBinding>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as CrawlerManagerBinding).executeCrawler === 'function',
    'CRAWLER_MANAGER service binding is required',
  ),
});

export type SchedulerManagerEnvironment = z.infer<typeof environmentSchema>;

export const parseSchedulerManagerEnvironment = (
  environment: WorkerEnvironment,
): SchedulerManagerEnvironment => parseEnvironment(environmentSchema, environment);
