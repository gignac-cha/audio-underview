import styled from '@emotion/styled';
import type { CrawlerRunLogEntry } from '../../schemas/crawler-runs.ts';
import { JSONResultPanel } from './JSONResultPanel.tsx';
import { StatusLogPanel } from './StatusLogPanel.tsx';
import { FileListPanel } from './FileListPanel.tsx';
import { findFileReferences } from './crawler-file-references.ts';

/**
 * What the Result section shows: a run that just ran or a run picked from the history.
 * error is a request that gave no answer; failed is a run that ended with an error of the crawler.
 */
export type RunOutput =
  | { status: 'idle' | 'running' | 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'success'; result: unknown; logs: CrawlerRunLogEntry[]; logsTruncated: boolean }
  | {
      status: 'failed';
      failure: { code: string; description: string };
      logs: CrawlerRunLogEntry[];
      logsTruncated: boolean;
    };

const Stack = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const Caption = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
`;

const LogsSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Label = styled.div`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const TruncatedNotice = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: #f59e0b;
`;

interface RunOutputPanelProperties {
  output: RunOutput;
  // Says whose result this is when it is not the run that just ran
  caption?: string;
}

export function RunOutputPanel({ output, caption }: RunOutputPanelProperties) {
  const isFinished = output.status === 'success' || output.status === 'failed';
  const files = output.status === 'success' ? findFileReferences(output.result) : [];

  return (
    <Stack>
      {caption && <Caption>{caption}</Caption>}
      <JSONResultPanel
        result={output.status === 'success' ? { result: output.result } : undefined}
        status={output.status}
        error={output.status === 'error' ? output.error : undefined}
        failure={output.status === 'failed' ? output.failure : undefined}
      />
      {isFinished && (
        <LogsSection>
          <Label>Logs</Label>
          {output.logsTruncated && <TruncatedNotice role="status">Logs were truncated.</TruncatedNotice>}
          <StatusLogPanel entries={output.logs} />
        </LogsSection>
      )}
      {files.length > 0 && <FileListPanel files={files} />}
    </Stack>
  );
}
