import {
  type CrawlerRunContext,
  type CrawlerRunOutcome,
  validateCrawlerRunOutcome,
} from '@audio-underview/worker-tools';

export type { CrawlerRunContext, CrawlerRunOutcome };

interface CrawlerManagerRPC {
  runCrawler(crawlerID: string, input: unknown, context: CrawlerRunContext): Promise<unknown>;
}

export interface CrawlerExecutionClient {
  /**
   * Runs a crawler for a user. A failure of the crawler code is a failed outcome with its logs;
   * the call throws when the crawler manager cannot run the crawler at all.
   */
  run(crawlerID: string, input: unknown, context: CrawlerRunContext): Promise<CrawlerRunOutcome>;
}

export class ServiceBindingCrawlerExecutionClient implements CrawlerExecutionClient {
  private readonly binding: Service;

  constructor(binding: Service) {
    this.binding = binding;
  }

  async run(crawlerID: string, input: unknown, context: CrawlerRunContext): Promise<CrawlerRunOutcome> {
    const raw = await (this.binding as unknown as CrawlerManagerRPC).runCrawler(crawlerID, input, context);
    return validateCrawlerRunOutcome(raw);
  }
}
