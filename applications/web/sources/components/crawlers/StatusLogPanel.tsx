import { useEffect, useRef } from 'react';
import styled from '@emotion/styled';
import type { LogEntry } from '../../hooks/use-crawler-code-runner.ts';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  flex: 1;
`;

const HeaderRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const Label = styled.div`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const ClearButton = styled.button`
  font-size: 0.75rem;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-secondary);
    background: var(--bg-surface);
  }
`;

const LogBox = styled.div`
  flex: 1;
  min-height: 200px;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.75rem;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.8;
`;

const LOG_LEVEL_COLORS: Record<LogEntry['level'], string> = {
  info: 'var(--text-secondary)',
  success: 'var(--color-success)',
  error: 'var(--color-error)',
};

const LogLine = styled.div<{ level: LogEntry['level'] }>`
  color: ${({ level }) => LOG_LEVEL_COLORS[level]};
  white-space: pre-wrap;
  word-break: break-all;
`;

const Timestamp = styled.span`
  color: var(--text-muted);
  margin-right: 0.5rem;
`;

const Details = styled.span`
  color: var(--text-muted);
  margin-left: 0.5rem;
`;

const EmptyMessage = styled.p`
  color: var(--text-muted);
  margin: 0;
  font-style: italic;
`;

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface StatusLogPanelProperties {
  entries: LogEntry[];
  onClear: () => void;
}

export function StatusLogPanel({ entries, onClear }: StatusLogPanelProperties) {
  const bottomReference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomReference.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <Container>
      <HeaderRow>
        <Label>Log</Label>
        {entries.length > 0 && (
          <ClearButton onClick={onClear}>Clear</ClearButton>
        )}
      </HeaderRow>
      <LogBox>
        {entries.length === 0 && (
          <EmptyMessage>No logs yet.</EmptyMessage>
        )}
        {entries.map((entry) => (
          <LogLine key={entry.id} level={entry.level}>
            <Timestamp>[{formatTimestamp(entry.timestamp)}]</Timestamp>
            {entry.message}
            {entry.details && <Details>({entry.details})</Details>}
          </LogLine>
        ))}
        <div ref={bottomReference} />
      </LogBox>
    </Container>
  );
}
