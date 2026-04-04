export interface CrawlerExecuteResult {
  type: 'web' | 'data';
  result: unknown;
}

interface CrawlerManagerRPC {
  executeCrawler(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult>;
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
    return (this.binding as unknown as CrawlerManagerRPC).executeCrawler(crawlerID, input);
  }
}
