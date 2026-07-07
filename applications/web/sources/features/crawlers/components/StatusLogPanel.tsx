import { useEffect, useRef } from 'react';
import { Button } from '../../../components/Button.tsx';
import { Section } from '../../../components/Section.tsx';
import type { LogEntry } from '../hooks/use-crawler-code-runner.ts';
import styles from './StatusLogPanel.module.css';

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export interface StatusLogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
}

/** 실행 상태 로그 (스펙 §4.3.12) — `[HH:MM:SS] message (details)`, 자동 스크롤, Clear. */
export const StatusLogPanel = ({ logs, onClear }: StatusLogPanelProps) => {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = listRef.current;
    if (node !== null && typeof node.scrollTo === 'function') {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }
  }, [logs.length]);

  return (
    <Section
      title={`Status log (${String(logs.length)})`}
      actions={
        logs.length > 0 ? (
          <Button variant="ghost" size="small" onClick={onClear}>
            Clear
          </Button>
        ) : undefined
      }
      padded={false}
    >
      <div ref={listRef} className={styles.list} aria-live="polite">
        {logs.length === 0 ? (
          <p className={styles.empty}>No logs yet.</p>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className={styles.entry} data-level={entry.level}>
              <span className={styles.time}>[{timeFormatter.format(entry.timestamp)}]</span>
              <span className={styles.message}>
                {entry.message}
                {entry.details !== undefined && (
                  <span className={styles.details}> ({entry.details})</span>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </Section>
  );
};
