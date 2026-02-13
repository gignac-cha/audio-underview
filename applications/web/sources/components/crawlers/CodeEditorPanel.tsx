import styled from '@emotion/styled';
import Editor from '@monaco-editor/react';
import { MAX_CODE_LENGTH } from '../../schemas/crawler-code-runner.ts';

const DEFAULT_CODE = `// Write a function that receives the page body as a string
// and returns the extracted data.
(body) => {
  return body.length;
}`;

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

const Label = styled.label`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const CharacterCounter = styled.span<{ isOver: boolean }>`
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: ${({ isOver }) => (isOver ? 'var(--color-error)' : 'var(--text-muted)')};
`;

const EditorWrapper = styled.div`
  flex: 1;
  min-height: 200px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  overflow: hidden;
`;

interface CodeEditorPanelProperties {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function CodeEditorPanel({ value, onChange, disabled }: CodeEditorPanelProperties) {
  const isOverLimit = value.length > MAX_CODE_LENGTH;
  const displayValue = value || DEFAULT_CODE;

  return (
    <Container>
      <HeaderRow>
        <Label>Crawler Code</Label>
        <CharacterCounter isOver={isOverLimit}>
          {value.length.toLocaleString()} / {MAX_CODE_LENGTH.toLocaleString()}
        </CharacterCounter>
      </HeaderRow>
      <EditorWrapper>
        <Editor
          defaultLanguage="javascript"
          theme="vs-dark"
          value={displayValue}
          onChange={(newValue) => onChange(newValue ?? '')}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            readOnly: disabled,
            padding: { top: 12 },
            wordWrap: 'on',
          }}
        />
      </EditorWrapper>
    </Container>
  );
}

export { DEFAULT_CODE };
