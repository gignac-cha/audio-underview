import {
  type CrawlerExecuteResult,
  validateCrawlerExecuteResult,
} from '@audio-underview/worker-tools';

export type { CrawlerExecuteResult };

interface CrawlerManagerRPC {
  executeCrawler(crawlerID: string, input: unknown): Promise<unknown>;
}

export interface CrawlerExecutionClient {
  execute(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult>;
}

export class ServiceBindingCrawlerExecutionClient implements CrawlerExecutionClient {
  private readonly binding: Service;

  constructor(binding: Service) {
    this.binding = binding;
  }

  async execute(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult> {
    const raw = await (this.binding as unknown as CrawlerManagerRPC).executeCrawler(crawlerID, input);
    return validateCrawlerExecuteResult(raw);
  }
}
