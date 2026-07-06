import { z } from 'zod';
import { plainObjectSchema } from '../common/json-objects.ts';

export const crawlerTypeSchema = z.enum(['web', 'data']);
export type CrawlerType = z.infer<typeof crawlerTypeSchema>;

/**
 * `crawlers` 테이블 행 = API가 반환하는 crawler 표현 (필드명은 DB 계약 그대로).
 */
export const crawlerSchema = z.object({
  id: z.uuid(),
  user_uuid: z.uuid(),
  name: z.string(),
  type: crawlerTypeSchema,
  url_pattern: z.string().nullable(),
  code: z.string(),
  input_schema: plainObjectSchema,
  output_schema: plainObjectSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export type Crawler = z.infer<typeof crawlerSchema>;

export const crawlerPermissionLevelSchema = z.enum(['owner', 'subscriber']);
export type CrawlerPermissionLevel = z.infer<typeof crawlerPermissionLevelSchema>;

export const crawlerPermissionSchema = z.object({
  id: z.uuid(),
  crawler_id: z.uuid(),
  user_uuid: z.uuid(),
  level: crawlerPermissionLevelSchema,
  created_at: z.string(),
});

export type CrawlerPermission = z.infer<typeof crawlerPermissionSchema>;
