import { MAXIMUM_CRAWLER_CODE_LENGTH } from '@audio-underview/schemas';
import Editor from '@monaco-editor/react';
import clsx from 'clsx';
import { useAtomValue } from 'jotai';
import { Section } from '../../../components/Section.tsx';
import { themeAtom } from '../../../state/theme.ts';
import styles from './CodePanel.module.css';

export interface CodePanelProps {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}

/** Monaco 코드 에디터 + `/10,000` 카운터. 테마는 앱 테마(themeAtom)에 연동. */
export const CodePanel = ({ value, readOnly, onChange }: CodePanelProps) => {
  const theme = useAtomValue(themeAtom);
  const length = value.length;
  const over = length > MAXIMUM_CRAWLER_CODE_LENGTH;

  return (
    <Section
      title="Code"
      hint={
        <span className={clsx(over && styles.over)}>
          {length.toLocaleString()} / {MAXIMUM_CRAWLER_CODE_LENGTH.toLocaleString()}
        </span>
      }
      padded={false}
    >
      <div className={styles.editor}>
        <Editor
          height="340px"
          language="javascript"
          theme={theme === 'dark' ? 'vs-dark' : 'light'}
          value={value}
          onChange={(next) => {
            onChange(next ?? '');
          }}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'JetBrains Mono Variable', monospace",
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            lineNumbersMinChars: 3,
            tabSize: 2,
            automaticLayout: true,
            renderLineHighlight: 'none',
            overviewRulerLanes: 0,
          }}
        />
      </div>
    </Section>
  );
};
