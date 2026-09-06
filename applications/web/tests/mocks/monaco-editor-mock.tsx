/**
 * jsdom에서 Monaco는 동작하지 않으므로 textarea 기반 mock으로 대체한다
 * (vite.config.ts test.alias). 실제 `@monaco-editor/react` 기본 export `Editor`를 흉내낸다.
 */
interface MockEditorProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  options?: { readOnly?: boolean };
  height?: string | number;
  language?: string;
  theme?: string;
}

const Editor = ({ value, onChange, options }: MockEditorProps) => (
  <textarea
    data-testid="code-editor"
    aria-label="Code editor"
    value={value ?? ''}
    readOnly={options?.readOnly ?? false}
    onChange={(event) => onChange?.(event.target.value)}
  />
);

export default Editor;
