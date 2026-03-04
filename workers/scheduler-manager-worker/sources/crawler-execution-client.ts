export interface CrawlerExecuteResult {
  type: 'web' | 'data';
  result: unknown;
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
    return (this.binding as any).executeCrawler(crawlerID, input);
  }
}
