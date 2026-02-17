import { useMutation } from '@tanstack/react-query';
import {
  crawlerRunSuccessResponseSchema,
  crawlerRunErrorResponseSchema,
  type CrawlerRunSuccessResponse,
} from '../schemas/crawler-code-runner.ts';

export interface LogEntry {
  id: string;
  timestamp: Date;
  level: 'info' | 'success' | 'error';
  message: string;
  details?: string;
}

interface UseCrawlerCodeRunnerOptions {
  onLog: (entry: LogEntry) => void;
}

function createLogEntry(level: LogEntry['level'], message: string, details?: string): LogEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    level,
    message,
    details,
  };
}

async function runCrawlerCode(url: string, code: string): Promise<CrawlerRunSuccessResponse> {
  const baseURL = import.meta.env.VITE_CRAWLER_CODE_RUNNER_URL;
  if (!baseURL) {
    throw new Error('VITE_CRAWLER_CODE_RUNNER_URL is not configured');
  }

  const controller = new AbortController();
  const timeoutID = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${baseURL}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test', url, code }),
      signal: controller.signal,
    });

    const body = await response.json();

    if (!response.ok) {
      const errorResult = crawlerRunErrorResponseSchema.safeParse(body);
      if (errorResult.success) {
        throw new Error(`${errorResult.data.error}: ${errorResult.data.error_description}`);
      }
      throw new Error(`Request failed with status ${response.status}`);
    }

    const successResult = crawlerRunSuccessResponseSchema.parse(body);
    return successResult;
  } finally {
    clearTimeout(timeoutID);
  }
}

export function useCrawlerCodeRunner({ onLog }: UseCrawlerCodeRunnerOptions) {
  const mutation = useMutation<CrawlerRunSuccessResponse, Error, { url: string; code: string }>({
    mutationFn: async ({ url, code }) => {
      onLog(createLogEntry('info', 'Starting test execution...'));
      onLog(createLogEntry('info', `Fetching ${url}`));

      try {
        const result = await runCrawlerCode(url, code);
        onLog(createLogEntry('success', 'Execution completed successfully'));
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        onLog(createLogEntry('error', 'Execution failed', message));
        throw error;
      }
    },
  });

  return {
    runTest: (url: string, code: string) => mutation.mutate({ url, code }),
    status: mutation.status === 'pending' ? ('running' as const) : mutation.status,
    result: mutation.data ?? null,
    error: mutation.error ?? null,
    reset: mutation.reset,
  };
}
