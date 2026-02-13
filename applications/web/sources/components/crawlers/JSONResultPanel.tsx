import { useState, useCallback } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-height: 0;
  flex: 1;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const Label = styled.div`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const CopyButton = styled('button', {
  shouldForwardProp: (prop) => prop !== 'copied',
})<{ copied: boolean }>`
  background: none;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  color: ${({ copied }) => (copied ? 'var(--color-success)' : 'var(--text-secondary)')};
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;

  &:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }
`;

const ResultBox = styled.div`
  flex: 1;
  min-height: 200px;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 1rem;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.6;
`;

const IdleMessage = styled.p`
  color: var(--text-muted);
  margin: 0;
  font-style: italic;
`;

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

const Spinner = styled.div`
  display: inline-block;
  width: 1rem;
  height: 1rem;
  border: 2px solid var(--border-subtle);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: ${spin} 0.6s linear infinite;
`;

const LoadingRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
`;

const ErrorMessage = styled.div`
  color: var(--color-error);
  white-space: pre-wrap;
`;

const JSONKey = styled.span`
  color: var(--accent-primary);
`;

const JSONString = styled.span`
  color: var(--color-success);
`;

const JSONNumber = styled.span`
  color: var(--accent-secondary);
`;

const JSONBoolean = styled.span`
  color: var(--accent-secondary);
`;

const JSONNull = styled.span`
  color: var(--text-muted);
`;

const JSONPunctuation = styled.span`
  color: var(--text-secondary);
`;

const Collapsible = styled.div`
  padding-left: 1.25rem;
`;

const MAX_DEPTH = 20;

function renderJSON(value: unknown, indent: number = 0): React.ReactNode {
  if (indent >= MAX_DEPTH) {
    return <JSONString>&quot;[max depth reached]&quot;</JSONString>;
  }
  if (value === null) {
    return <JSONNull>null</JSONNull>;
  }

  if (value === undefined) {
    return <JSONNull>undefined</JSONNull>;
  }

  if (typeof value === 'string') {
    const truncated = value.length > 500 ? value.slice(0, 500) + '...' : value;
    return <JSONString>&quot;{truncated}&quot;</JSONString>;
  }

  if (typeof value === 'number') {
    return <JSONNumber>{value}</JSONNumber>;
  }

  if (typeof value === 'boolean') {
    return <JSONBoolean>{String(value)}</JSONBoolean>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <JSONPunctuation>[]</JSONPunctuation>;
    }
    return (
      <span>
        <JSONPunctuation>[</JSONPunctuation>
        <Collapsible>
          {value.map((item, index) => (
            <div key={index}>
              {renderJSON(item, indent + 1)}
              {index < value.length - 1 && <JSONPunctuation>,</JSONPunctuation>}
            </div>
          ))}
        </Collapsible>
        <JSONPunctuation>]</JSONPunctuation>
      </span>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <JSONPunctuation>{'{}'}</JSONPunctuation>;
    }
    return (
      <span>
        <JSONPunctuation>{'{'}</JSONPunctuation>
        <Collapsible>
          {entries.map(([key, val], index) => (
            <div key={key}>
              <JSONKey>&quot;{key}&quot;</JSONKey>
              <JSONPunctuation>: </JSONPunctuation>
              {renderJSON(val, indent + 1)}
              {index < entries.length - 1 && <JSONPunctuation>,</JSONPunctuation>}
            </div>
          ))}
        </Collapsible>
        <JSONPunctuation>{'}'}</JSONPunctuation>
      </span>
    );
  }

  return <JSONString>{String(value)}</JSONString>;
}

type Status = 'idle' | 'running' | 'success' | 'error';

interface JSONResultPanelProperties {
  result: { type: string; result: unknown } | null;
  status: Status;
  error?: Error | null;
}

export function JSONResultPanel({ result, status, error }: JSONResultPanelProperties) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!result) return;
    const text = JSON.stringify(result.result, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Clipboard API may fail in insecure contexts or due to permission denial
    });
  }, [result]);

  return (
    <Container>
      <Header>
        <Label>Result</Label>
        {status === 'success' && result && (
          <CopyButton copied={copied} onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </CopyButton>
        )}
      </Header>
      <ResultBox>
        {status === 'idle' && (
          <IdleMessage>Run a test to see results here.</IdleMessage>
        )}
        {status === 'running' && (
          <LoadingRow>
            <Spinner />
            <span>Executing...</span>
          </LoadingRow>
        )}
        {status === 'error' && (
          <ErrorMessage>{error?.message ?? 'An unknown error occurred.'}</ErrorMessage>
        )}
        {status === 'success' && result && renderJSON(result.result)}
      </ResultBox>
    </Container>
  );
}
