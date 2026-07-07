import type { CrawlerType } from '@audio-underview/schemas';
import { Button } from '../../../components/Button.tsx';
import { TextArea, TextField } from '../../../components/FormControls.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { Section } from '../../../components/Section.tsx';
import { shortcutLabel } from '../../../hooks/use-platform.ts';
import type { useCrawlerCodeRunner } from '../hooks/use-crawler-code-runner.ts';
import { JSONResultPanel } from './JSONResultPanel.tsx';
import { StatusLogPanel } from './StatusLogPanel.tsx';
import styles from './TestPanel.module.css';

const isInvalidURL = (value: string): boolean => {
  if (value.trim().length === 0) {
    return false;
  }
  try {
    new URL(value.trim());
    return false;
  } catch {
    return true;
  }
};

export interface TestPanelProps {
  crawlerType: CrawlerType;
  isDraft: boolean;
  testURL: string;
  testData: string;
  canRunTest: boolean;
  onURLChange: (value: string) => void;
  onDataChange: (value: string) => void;
  onRun: () => void;
  runner: ReturnType<typeof useCrawlerCodeRunner>;
}

/** 우측 테스트 컬럼 — Test Runner + Result + Status log. draft 코드로 실행(보존 §5). */
export const TestPanel = ({
  crawlerType,
  isDraft,
  testURL,
  testData,
  canRunTest,
  onURLChange,
  onDataChange,
  onRun,
  runner,
}: TestPanelProps) => {
  const running = runner.status === 'running';

  return (
    <div className={styles.column}>
      <Section
        title="Test Runner"
        hint={isDraft ? '· running draft' : undefined}
        actions={
          <Button
            variant="primary"
            size="small"
            iconLeft={<Icon name="play" size={14} />}
            shortcutHint={shortcutLabel('↵')}
            disabled={!canRunTest}
            onClick={onRun}
          >
            {running ? 'Running…' : 'Run test'}
          </Button>
        }
      >
        {crawlerType === 'web' ? (
          <TextField
            type="url"
            label="Target URL"
            placeholder="https://example.com"
            value={testURL}
            disabled={running}
            aria-invalid={isInvalidURL(testURL) ? true : undefined}
            onChange={(event) => {
              onURLChange(event.target.value);
            }}
          />
        ) : (
          <TextArea
            monospace
            rows={4}
            label="Input data (JSON)"
            placeholder='{ "example": true }'
            value={testData}
            disabled={running}
            onChange={(event) => {
              onDataChange(event.target.value);
            }}
          />
        )}
      </Section>

      <JSONResultPanel status={runner.status} result={runner.result} error={runner.error} />

      <StatusLogPanel logs={runner.logs} onClear={runner.clearLogs} />
    </div>
  );
};
