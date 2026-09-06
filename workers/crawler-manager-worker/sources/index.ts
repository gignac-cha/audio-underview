import { WorkerEntrypoint } from 'cloudflare:workers';
import { createWorkerLogger } from '@audio-underview/logger';
import type { CrawlerExecuteResult } from '@audio-underview/schemas';
import { createCrawlerManagerRouter, SERVICE_NAME } from './application.ts';
import { executeCrawler } from './crawler-executor.ts';
import type { WorkerEnvironment } from './environment.ts';
import { createServices } from './services.ts';

const router = createCrawlerManagerRouter(createServices);

/**
 * crawler CRUD HTTP API + Service Binding RPC.
 * `executeCrawler`는 scheduler-manager 전용 진입점 — 소유권 검사 없음
 * (binding 선언 자체가 접근 제어, 스펙 §3.4).
 */
export default class CrawlerManagerWorker extends WorkerEntrypoint<WorkerEnvironment> {
  override fetch(request: Request): Promise<Response> {
    return router.fetch(request, this.env, this.ctx);
  }

  async executeCrawler(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult> {
    const logger = createWorkerLogger({ defaultContext: { module: SERVICE_NAME } });
    try {
      return await executeCrawler(createServices(this.env), logger, crawlerID, input);
    } finally {
      this.ctx.waitUntil(logger.flush());
    }
  }
}
