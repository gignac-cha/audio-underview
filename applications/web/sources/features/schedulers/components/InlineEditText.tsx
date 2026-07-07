import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import styles from './InlineEditText.module.css';

export interface InlineEditTextProps {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  monospace?: boolean;
  /** 빈 값 commit 허용 (cron → null). false면 빈 값은 원복. */
  allowEmpty?: boolean;
  emptyDisplay?: string;
  invalid?: (value: string) => boolean;
  onCommit: (value: string | null) => void;
}

/**
 * 인라인 편집 (스펙 §4.5.1): 클릭/Enter로 진입, blur·Enter commit, Escape 취소.
 * trim 후 변경 시에만 commit. allowEmpty면 빈 값 → null.
 */
export const InlineEditText = ({
  value,
  ariaLabel,
  placeholder,
  monospace = false,
  allowEmpty = false,
  emptyDisplay = 'Not set',
  invalid,
  onCommit,
}: InlineEditTextProps) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(value);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === value.trim()) {
      return;
    }
    if (trimmed.length === 0) {
      if (allowEmpty) {
        onCommit(null);
      }
      return;
    }
    if (invalid?.(trimmed) === true) {
      return;
    }
    onCommit(trimmed);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    const showInvalid = invalid?.(draft.trim()) === true && draft.trim().length > 0;
    return (
      <input
        ref={inputRef}
        className={clsx(styles.input, monospace && styles.mono)}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={showInvalid ? true : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
      />
    );
  }

  const isEmpty = value.trim().length === 0;
  return (
    <button
      type="button"
      className={clsx(styles.display, monospace && styles.mono, isEmpty && styles.empty)}
      aria-label={`${ariaLabel} (click to edit)`}
      onClick={startEditing}
    >
      {isEmpty ? emptyDisplay : value}
    </button>
  );
};
