import styled from '@emotion/styled';
import type { CrawlerRunLogEntry } from '../../schemas/crawler-runs.ts';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
`;

const LogBox = styled.div`
  max-height: 320px;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.75rem;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.8;
`;

const LOG_LEVEL_COLORS: Record<CrawlerRunLogEntry['level'], string> = {
  debug: 'var(--text-muted)',
  info: 'var(--text-secondary)',
  log: 'var(--text-secondary)',
  warn: '#f59e0b',
  error: 'var(--color-error)',
};

const LogLine = styled('div', {
  shouldForwardProp: (prop) => prop !== 'level',
})<{ level: CrawlerRunLogEntry['level'] }>`
  color: ${({ level }) => LOG_LEVEL_COLORS[level]};
  white-space: pre-wrap;
  word-break: break-all;
`;

const Timestamp = styled.span`
  color: var(--text-muted);
  margin-right: 0.5rem;
`;

const Level = styled.span`
  margin-right: 0.5rem;
  font-weight: 600;
`;

const EmptyMessage = styled.p`
  color: var(--text-muted);
  margin: 0;
  font-style: italic;
`;

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString('en-US', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface StatusLogPanelProperties {
  entries: CrawlerRunLogEntry[];
}

export function StatusLogPanel({ entries }: StatusLogPanelProperties) {
  return (
    <Container>
      <LogBox role="log" aria-label="Crawler logs">
        {entries.length === 0 && <EmptyMessage>No logs.</EmptyMessage>}
        {entries.map((entry, index) => (
          <LogLine key={index} level={entry.level}>
            <Timestamp>[{formatTimestamp(entry.timestamp)}]</Timestamp>
            <Level>{entry.level.toUpperCase()}</Level>
            {entry.message}
          </LogLine>
        ))}
      </LogBox>
    </Container>
  );
}
