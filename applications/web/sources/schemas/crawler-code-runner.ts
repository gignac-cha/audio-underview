import { z } from 'zod';

export const MAX_CODE_LENGTH = 10_000;

export const crawlerRunRequestSchema = z.object({
  type: z.enum(['test', 'run']),
  url: z.string().url(),
  code: z.string().min(1).max(MAX_CODE_LENGTH),
});

export type CrawlerRunRequest = z.infer<typeof crawlerRunRequestSchema>;

export const crawlerRunSuccessResponseSchema = z.object({
  type: z.enum(['test', 'run']),
  result: z.unknown(),
});

export type CrawlerRunSuccessResponse = z.infer<typeof crawlerRunSuccessResponseSchema>;

export const crawlerRunErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string(),
});

export type CrawlerRunErrorResponse = z.infer<typeof crawlerRunErrorResponseSchema>;
