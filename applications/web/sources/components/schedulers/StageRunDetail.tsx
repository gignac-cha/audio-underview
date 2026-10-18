import styled from '@emotion/styled';
import { isInProgress, useGetStageRun, type StageRunSummary } from '../../hooks/use-scheduler-runs.ts';
import { StatusLogPanel } from '../crawlers/StatusLogPanel.tsx';
import { FileListPanel } from '../crawlers/FileListPanel.tsx';
import { findFileReferences } from '../crawlers/crawler-file-references.ts';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-deep);
`;

const Label = styled.span`
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
`;

const Content = styled.pre`
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  margin: 0 0 0.5rem 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
`;

const Message = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-muted);
`;

const ErrorMessage = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  color: var(--status-error, #e53e3e);
`;

const TruncatedNotice = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: #f59e0b;
`;

function formatJSON(value: unknown): string {
  return value === null || value === undefined ? 'None' : JSON.stringify(value, null, 2);
}

interface StageRunDetailProperties {
  schedulerID: string;
  runID: string;
  // The stage run as the run lists it, which says whether it has ended
  stageRun: StageRunSummary;
}

export function StageRunDetail({ schedulerID, runID, stageRun }: StageRunDetailProperties) {
  const { stageRun: detail, isLoading, error } = useGetStageRun(
    schedulerID,
    runID,
    stageRun.id,
    !isInProgress(stageRun.status),
  );

  if (isLoading) {
    return <Container><Message>Loading...</Message></Container>;
  }
  if (error) {
    return <Container><ErrorMessage>Failed to load stage run: {error.message}</ErrorMessage></Container>;
  }
  if (!detail) {
    return null;
  }

  const files = findFileReferences(detail.output);

  return (
    <Container>
      <Label>Input</Label>
      <Content>{formatJSON(detail.input)}</Content>
      <Label>Output</Label>
      <Content>{formatJSON(detail.output)}</Content>
      {files.length > 0 && <FileListPanel files={files} />}
      <Label>Logs</Label>
      {detail.logs_truncated && <TruncatedNotice role="status">Logs were truncated.</TruncatedNotice>}
      <StatusLogPanel entries={detail.logs ?? []} />
    </Container>
  );
}
