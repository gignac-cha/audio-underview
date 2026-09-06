import { useState, type ReactNode } from 'react';
import { Button } from '../../../components/Button.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { Section } from '../../../components/Section.tsx';
import { Spinner } from '../../../components/Spinner.tsx';
import type { CodeRunnerStatus } from '../hooks/use-crawler-code-runner.ts';
import styles from './JSONResultPanel.module.css';

const MAX_DEPTH = 20;
const MAX_STRING_LENGTH = 500;

const JsonNode = ({ value, depth }: { value: unknown; depth: number }): ReactNode => {
  if (depth > MAX_DEPTH) {
    return <span className={styles.faint}>[max depth reached]</span>;
  }
  if (value === null) {
    return <span className={styles.null}>null</span>;
  }
  if (value === undefined) {
    return <span className={styles.faint}>undefined</span>;
  }
  if (typeof value === 'string') {
    const truncated =
      value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
    return <span className={styles.string}>{JSON.stringify(truncated)}</span>;
  }
  if (typeof value === 'number') {
    return <span className={styles.number}>{value}</span>;
  }
  if (typeof value === 'boolean') {
    return <span className={styles.boolean}>{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.length === 0) {
      return <span className={styles.punctuation}>[]</span>;
    }
    return (
      <>
        <span className={styles.punctuation}>[</span>
        <div className={styles.nested}>
          {items.map((item, index) => (
            <div key={index} className={styles.row}>
              <JsonNode value={item} depth={depth + 1} />
              {index < items.length - 1 && <span className={styles.punctuation}>,</span>}
            </div>
          ))}
        </div>
        <span className={styles.punctuation}>]</span>
      </>
    );
  }
  if (typeof value === 'object') {
    const entries: [string, unknown][] = Object.entries(value);
    if (entries.length === 0) {
      return <span className={styles.punctuation}>{'{}'}</span>;
    }
    return (
      <>
        <span className={styles.punctuation}>{'{'}</span>
        <div className={styles.nested}>
          {entries.map(([key, item], index) => (
            <div key={key} className={styles.row}>
              <span className={styles.key}>{JSON.stringify(key)}</span>
              <span className={styles.punctuation}>: </span>
              <JsonNode value={item} depth={depth + 1} />
              {index < entries.length - 1 && <span className={styles.punctuation}>,</span>}
            </div>
          ))}
        </div>
        <span className={styles.punctuation}>{'}'}</span>
      </>
    );
  }
  return null;
};

export interface JSONResultPanelProps {
  status: CodeRunnerStatus;
  result: unknown;
  error?: Error;
}

/** 테스트 결과 패널 (스펙 §4.3.11) — idle/running/error/success + JSON 트리 + Copy. */
export const JSONResultPanel = ({ status, result, error }: JSONResultPanelProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(JSON.stringify(result, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        // 클립보드 실패는 무시
      });
  };

  return (
    <Section
      title="Result"
      actions={
        status === 'success' ? (
          <Button
            variant="ghost"
            size="small"
            iconLeft={<Icon name={copied ? 'check' : 'copy'} size={14} />}
            onClick={handleCopy}
          >
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        ) : undefined
      }
      padded={false}
    >
      <div className={styles.body}>
        {status === 'idle' && <p className={styles.hint}>Run a test to see results here.</p>}
        {status === 'running' && (
          <div className={styles.running}>
            <Spinner size={18} label="Executing…" />
          </div>
        )}
        {status === 'error' && (
          <p className={styles.error}>{error?.message ?? 'Execution failed.'}</p>
        )}
        {status === 'success' && (
          <pre className={styles.tree}>
            <JsonNode value={result} depth={0} />
          </pre>
        )}
      </div>
    </Section>
  );
};
