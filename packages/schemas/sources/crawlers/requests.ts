import { z } from 'zod';
import {
  MAXIMUM_CRAWLER_CODE_LENGTH,
  MAXIMUM_NAME_LENGTH,
  MAXIMUM_URL_PATTERN_LENGTH,
} from '../common/limits.ts';
import { plainObjectSchema } from '../common/json-objects.ts';
import { crawlerTypeSchema } from './entities.ts';

const nameSchema = z
  .string("Field 'name' is required and must be a non-empty string")
  .max(MAXIMUM_NAME_LENGTH, `Field 'name' must not exceed ${MAXIMUM_NAME_LENGTH} characters`)
  .refine((value) => value.trim().length > 0, {
    message: "Field 'name' is required and must be a non-empty string",
  });

const codeSchema = z
  .string("Field 'code' is required and must be a non-empty string")
  .max(
    MAXIMUM_CRAWLER_CODE_LENGTH,
    `Field 'code' must not exceed ${MAXIMUM_CRAWLER_CODE_LENGTH} characters`,
  )
  .refine((value) => value.trim().length > 0, {
    message: "Field 'code' is required and must be a non-empty string",
  });

const isCompilableRegularExpression = (pattern: string): boolean => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

/**
 * crawler 생성/전체 교체 body. PUT은 POST와 동일 검증 (레거시 계약 §3.1).
 *
 * type별 조건:
 * - `web`: `url_pattern` 필수 (컴파일 가능한 regex). ReDoS 안전성 검사는 서버 정책이므로
 *   worker 계층에서 수행한다.
 * - `data`: `input_schema` 필수.
 *
 * 서버 측 정규화(스키마 밖): web이면 `input_schema = { body: 'string' }` 강제,
 * data면 `url_pattern = null` 저장.
 */
export const saveCrawlerBodySchema = z
  .object({
    name: nameSchema,
    type: crawlerTypeSchema.default('web'),
    url_pattern: z
      .string("Field 'url_pattern' must be a string")
      .max(
        MAXIMUM_URL_PATTERN_LENGTH,
        `Field 'url_pattern' must not exceed ${MAXIMUM_URL_PATTERN_LENGTH} characters`,
      )
      .refine(isCompilableRegularExpression, {
        message: "Field 'url_pattern' must be a valid regex",
      })
      .optional(),
    code: codeSchema,
    input_schema: plainObjectSchema.optional(),
    output_schema: plainObjectSchema.optional(),
  })
  .superRefine((value, refinementContext) => {
    if (value.type === 'web' && value.url_pattern === undefined) {
      refinementContext.addIssue({
        code: 'custom',
        path: ['url_pattern'],
        message: "Field 'url_pattern' is required for web crawlers",
      });
    }
    if (value.type === 'data' && value.input_schema === undefined) {
      refinementContext.addIssue({
        code: 'custom',
        path: ['input_schema'],
        message: "Field 'input_schema' is required for data crawlers and must be a JSON object",
      });
    }
  });

export type SaveCrawlerBody = z.infer<typeof saveCrawlerBodySchema>;
