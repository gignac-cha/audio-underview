/**
 * Worker environment bindings, and the parameters one newscast Workflow instance runs with.
 *
 * Kept in its own module so the HTTP entry, the task group entrypoint and the durable
 * Workflow (`workflow.ts`) can share the types without a circular import.
 */

import type { JobRequestSnapshot, LlmProvider } from '@audio-underview/newscast-core';
import { LLM_PROVIDERS } from '@audio-underview/newscast-core';

/**
 * The source and the settings ONE newscast is made with — the `newscasts.request` column, and
 * the `request` of the Workflow parameters.
 *
 * The shape is the core {@link JobRequestSnapshot}, so a reader of the core type reads it as it
 * is, with two fields the task group adds:
 * - url: the `{ url }` input. The article is read with the article-content crawler alone, so the
 *   newscast has no GeekNews summary and no Hacker News comments. `entries` is then absent.
 * - signal: the `signal` setting. The sting is made only when it is true and the newscast has two
 *   or more parts.
 *
 * Exactly one of `entries` (one article), `url` and `customArticle` is present. `limit` is always 1:
 * one source makes one newscast. The voices are drawn once, when the row is inserted, so a
 * repeated start and every durable-step retry keep the same pair.
 */
export interface NewscastRequest extends JobRequestSnapshot {
  url?: string;
  signal: boolean;
}

/**
 * Parameters carried by a newscast Workflow instance (the `params` of
 * `NEWSCAST_WORKFLOW.createBatch`). Kept small and JSON-serializable: the Workflow reads everything
 * else it needs from `this.env`.
 */
export interface NewscastWorkflowParameters {
  /** The `newscasts` row id, and the first segment of the R2 audio keys */
  newscastID: string;
  /**
   * Owner of the scheduler that ran the stage. Every provider call is made with this user's keys
   * through the vault, and the checkpoints are namespaced by it (`chk/{userUUID}/{newscastID}/...`).
   */
  userUUID: string;
  /** The task group stage run the newscast belongs to; the final step reports to the scheduler about it */
  stageRunID: string;
  request: NewscastRequest;
  /**
   * True when this instance RESUMES a failed newscast. Only then does the pipeline consume the
   * `chk/...` KV checkpoints to skip work the failed run already completed; a normal run writes
   * checkpoints but never reads them. Nothing sets it yet: resuming a failed newscast is not part
   * of this unit (design §4).
   */
  resume?: boolean;
}

/** Result shape returned by the crawler manager's executeCrawler* RPCs. */
export interface CrawlerExecuteResult {
  type: 'web' | 'data';
  result: unknown;
}

/**
 * Service binding to `crawler-manager-worker`. The crawl step reads each article through the
 * system crawlers, referenced by name (article-content / geeknews-summary / hn-search / hn-items).
 */
export interface CrawlerManagerService {
  executeCrawlerByName(name: string, input: unknown): Promise<CrawlerExecuteResult>;
}

/** What the group reports about the progress of a stage run (scheduler `task-group-reports.ts`). */
export interface TaskGroupProgressReport {
  /** 1 to 500 characters */
  message: string;
  completed?: number;
  total?: number;
}

export interface TaskGroupReportResult {
  /** false when the stage run ended otherwise or does not exist */
  accepted: boolean;
}

/**
 * The `TaskGroupReports` entrypoint of scheduler-manager-worker. A report that throws may be sent
 * again, except a TypeError, which means the arguments are wrong.
 */
export interface TaskGroupReportsService {
  reportProgress(stageRunID: string, progress: TaskGroupProgressReport): Promise<TaskGroupReportResult>;
  complete(stageRunID: string, output: unknown): Promise<TaskGroupReportResult>;
  fail(stageRunID: string, errorMessage: string): Promise<TaskGroupReportResult>;
}

export interface Environment {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  /** The Postgres schema of the environment (`public`, `staging`, `development`) */
  SUPABASE_SCHEMA: string;
  /** HS256 secret of the main session JWT; the media token key is derived from it */
  JWT_SECRET: string;
  /** CSV of allowed CORS origins */
  ALLOWED_ORIGINS: string;
  /** The vault's internal token, sent in the x-user-vault-token header when set */
  VAULT_INTERNAL_TOKEN?: string;
  /**
   * Service binding to `user-vault-worker`. Every provider call goes through its `/internal/proxy`
   * with the key of the user (`user-vault-transport.ts`); this worker holds no provider key.
   */
  USER_VAULT: Fetcher;
  CRAWLER_MANAGER: CrawlerManagerService;
  SCHEDULER_TASK_GROUP_REPORTS: TaskGroupReportsService;
  /** The audio of each newscast: `<newscastID>/part-<N>` and `<newscastID>/signal` */
  NEWSCAST_AUDIO: R2Bucket;
  /** TTS chunk PCM (`seg/...`) and step checkpoints (`chk/...`), both with a 7-day TTL */
  NEWSCAST_STATE: KVNamespace;
  /** One instance makes one newscast */
  NEWSCAST_WORKFLOW: Workflow<NewscastWorkflowParameters>;
}

/**
 * How long a `seg/` chunk and a `chk/` checkpoint live in KV. Finalize deletes both, so the TTL only
 * matters for a newscast that failed: its PCM and checkpoints expire instead of staying for good.
 */
export const NEWSCAST_STATE_TIME_TO_LIVE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Narrow an arbitrary value to a valid {@link LlmProvider}, or `undefined` when it is not one of
 * the supported providers.
 */
export function parseProvider(value: unknown): LlmProvider | undefined {
  return typeof value === 'string' && LLM_PROVIDERS.includes(value as LlmProvider)
    ? (value as LlmProvider)
    : undefined;
}
