import { z } from 'zod';
import { MAXIMUM_CRAWLER_CODE_LENGTH } from '../common/limits.ts';
import { crawlerTypeSchema } from '../crawlers/entities.ts';

export const codeRunnerModeSchema = z.enum(['test', 'run']);
export type CodeRunnerMode = z.infer<typeof codeRunnerModeSchema>;

const codeSchema = z
  .string("Field 'code' is required and must be a string")
  .max(
    MAXIMUM_CRAWLER_CODE_LENGTH,
    `Field 'code' must not exceed ${MAXIMUM_CRAWLER_CODE_LENGTH} characters`,
  );

/**
 * `POST /run` 요청 (code-runner).
 *
 * `code`는 함수 표현식 문자열 (`(input) => ...` 등) — 실행부가 `(${code})`를 평가해 호출한다.
 * `mode`는 실행 동작에 영향 없이 응답에 에코된다 (관례: 에디터 = test, 파이프라인 = run).
 */
export const runCodeRequestBodySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('web'),
    mode: codeRunnerModeSchema,
    url: z.url("Field 'url' must be a valid URL"),
    code: codeSchema,
  }),
  z.object({
    type: z.literal('data'),
    mode: codeRunnerModeSchema,
    data: z.unknown(),
    code: codeSchema,
  }),
]);

export type RunCodeRequestBody = z.infer<typeof runCodeRequestBodySchema>;

/**
 * `POST /run` 성공 응답. 사용자 코드가 `undefined`를 반환하면 JSON 직렬화 과정에서
 * `result` 키가 생략되므로 소비자는 키 부재를 `undefined`로 취급해야 한다.
 * (레거시 client는 키 부재를 에러로 처리하는 잠복 버그가 있었다 — 재작성에서 수용으로 변경.)
 */
export const codeRunnerResultSchema = z.object({
  type: crawlerTypeSchema,
  mode: codeRunnerModeSchema,
  result: z.unknown().optional(),
});

export type CodeRunnerResult = z.infer<typeof codeRunnerResultSchema>;

/**
 * crawler-manager Service Binding RPC `executeCrawler`의 반환 계약.
 * HTTP 계약(`CodeRunnerResult`)과 달리 `mode`가 없다.
 */
export const crawlerExecuteResultSchema = z.object({
  type: crawlerTypeSchema,
  result: z.unknown().optional(),
});

export type CrawlerExecuteResult = z.infer<typeof crawlerExecuteResultSchema>;
