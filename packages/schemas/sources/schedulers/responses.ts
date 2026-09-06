import { z } from 'zod';
import { schedulerRunStatusSchema } from './entities.ts';

/**
 * `POST /schedulers/:id/execute` 응답 (동기 실행 결과).
 * HTTP status는 status/error 조합으로 결정된다 (worker의 resolveHTTPStatus).
 */
export const executeSchedulerResponseSchema = z.object({
  run_id: z.uuid(),
  status: schedulerRunStatusSchema,
  result: z.unknown(),
  error: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});

export type ExecuteSchedulerResponse = z.infer<typeof executeSchedulerResponseSchema>;
