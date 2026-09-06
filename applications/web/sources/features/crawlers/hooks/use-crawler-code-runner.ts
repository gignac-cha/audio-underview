import { codeRunnerResultSchema, type CodeRunnerResult } from '@audio-underview/schemas';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useApiClient } from '../../../api/use-api-client.tsx';
import { toErrorMessage } from '../../../api/errors.ts';

export type LogLevel = 'info' | 'success' | 'error';

export interface LogEntry {
  id: number;
  timestamp: number;
  level: LogLevel;
  message: string;
  details?: string;
}

export type CodeRunnerInput =
  | { type: 'web'; url: string; code: string }
  | { type: 'data'; data: unknown; code: string };

export type CodeRunnerStatus = 'idle' | 'running' | 'success' | 'error';

let logSequence = 0;

/**
 * 테스트 실행 mutation + 로그 발행 (스펙 §4.3.10).
 * - code-runner `POST /run` 호출 (**Bearer JWT 첨부** — 태스크 계약), body `{type, mode:'test', url|data, code}`.
 * - 로그는 실행 간 리셋되지 않고 누적 — Clear로만 비운다.
 * - mutation status `pending`을 `running`으로 리매핑.
 */
export const useCrawlerCodeRunner = () => {
  const client = useApiClient();
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const appendLog = useCallback((level: LogLevel, message: string, details?: string) => {
    logSequence += 1;
    setLogs((previous) => [
      ...previous,
      { id: logSequence, timestamp: Date.now(), level, message, details },
    ]);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const mutation = useMutation<CodeRunnerResult, Error, CodeRunnerInput>({
    mutationFn: async (input) => {
      appendLog('info', 'Starting test execution...');
      if (input.type === 'web') {
        appendLog('info', `Fetching ${input.url}`);
      } else {
        appendLog('info', 'Running with provided data');
      }
      const body =
        input.type === 'web'
          ? { type: 'web' as const, mode: 'test' as const, url: input.url, code: input.code }
          : { type: 'data' as const, mode: 'test' as const, data: input.data, code: input.code };
      return client.request('VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL', '/run', {
        method: 'POST',
        body,
        schema: codeRunnerResultSchema,
      });
    },
    onSuccess: () => {
      appendLog('success', 'Execution completed successfully');
    },
    onError: (error) => {
      appendLog('error', 'Execution failed', toErrorMessage(error));
    },
  });

  const status: CodeRunnerStatus =
    mutation.status === 'pending' ? 'running' : mutation.status;

  return {
    run: mutation.mutate,
    status,
    result: mutation.data,
    error: mutation.error ?? undefined,
    logs,
    clearLogs,
    reset: mutation.reset,
  };
};
