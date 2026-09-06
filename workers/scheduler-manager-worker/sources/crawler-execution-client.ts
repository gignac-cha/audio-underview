import {
  crawlerExecuteResultSchema,
  type CrawlerExecuteResult,
} from '@audio-underview/schemas';
import type { CrawlerManagerBinding } from './environment.ts';

export interface CrawlerExecutionClient {
  execute(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult>;
}

/**
 * Service Binding RPC 결과의 런타임 검증 (스펙 §4.8).
 * 검증 실패 메시지 prefix "Invalid CrawlerExecuteResult"는 실행 handler의
 * HTTP status 매핑(502)이 의존하는 계약이다.
 */
export const createServiceBindingCrawlerExecutionClient = (
  binding: CrawlerManagerBinding,
): CrawlerExecutionClient => ({
  async execute(crawlerID, input) {
    const raw = await binding.executeCrawler(crawlerID, input);
    const parsed = crawlerExecuteResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid CrawlerExecuteResult: ${parsed.error.issues[0]?.message ?? 'unexpected shape'}`,
      );
    }
    return parsed.data;
  },
});
