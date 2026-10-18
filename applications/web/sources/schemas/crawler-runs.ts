import { z } from 'zod';

/**
 * The shapes the crawler manager answers for crawler runs, run history and environment variables.
 */

export const crawlerRunLogEntrySchema = z.object({
  level: z.enum(['debug', 'info', 'log', 'warn', 'error']),
  message: z.string(),
  timestamp: z.string(),
  item_index: z.number().optional(),
});

export type CrawlerRunLogEntry = z.infer<typeof crawlerRunLogEntrySchema>;

const logFields = {
  logs: z.array(crawlerRunLogEntrySchema),
  logs_truncated: z.boolean(),
};

/**
 * The answer of POST /crawlers/:id/runs, POST /crawlers/:id/test-runs and POST /crawler-test-runs.
 * run_id is null when the run could not be recorded. A failed run answers with a 4xx or 5xx status.
 */
export const crawlerRunCompletedSchema = z.object({
  run_id: z.string().nullable(),
  status: z.literal('completed'),
  result: z.unknown(),
  ...logFields,
});

export const crawlerRunFailedSchema = z.object({
  run_id: z.string().nullable(),
  status: z.literal('failed'),
  error: z.string(),
  error_description: z.string(),
  ...logFields,
});

export const crawlerRunExecutionSchema = z.discriminatedUnion('status', [
  crawlerRunCompletedSchema,
  crawlerRunFailedSchema,
]);

export type CrawlerRunCompleted = z.infer<typeof crawlerRunCompletedSchema>;
export type CrawlerRunFailed = z.infer<typeof crawlerRunFailedSchema>;
export type CrawlerRunExecution = z.infer<typeof crawlerRunExecutionSchema>;

export const crawlerRunKindSchema = z.enum(['direct', 'test']);

export type CrawlerRunKind = z.infer<typeof crawlerRunKindSchema>;

/**
 * One row of a run history list: no result, logs or code.
 * type is null on a run recorded before test runs existed.
 */
export const crawlerRunSummarySchema = z.object({
  id: z.string(),
  crawler_id: z.string().nullable(),
  kind: crawlerRunKindSchema,
  type: z.enum(['web', 'data']).nullable(),
  status: z.enum(['completed', 'failed']),
  error_code: z.string().nullable(),
  logs_truncated: z.boolean(),
  started_at: z.string(),
  completed_at: z.string(),
  created_at: z.string(),
});

export type CrawlerRunSummary = z.infer<typeof crawlerRunSummarySchema>;

export const crawlerRunListSchema = z.object({
  data: z.array(crawlerRunSummarySchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number(),
});

export type CrawlerRunList = z.infer<typeof crawlerRunListSchema>;

/**
 * One run with its result, logs and, on a test run, the code that ran.
 */
export const crawlerRunDetailSchema = crawlerRunSummarySchema.extend({
  user_uuid: z.string(),
  result: z.unknown(),
  error: z.string().nullable(),
  logs: z.array(crawlerRunLogEntrySchema),
  code: z.string().nullable(),
});

export type CrawlerRunDetail = z.infer<typeof crawlerRunDetailSchema>;

/**
 * An environment variable without its value, which the crawler manager never sends back.
 */
export const environmentVariableSummarySchema = z.object({
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type EnvironmentVariableSummary = z.infer<typeof environmentVariableSummarySchema>;

export const environmentVariableListSchema = z.object({
  data: z.array(environmentVariableSummarySchema),
});
