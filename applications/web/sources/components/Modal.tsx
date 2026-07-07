import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.tsx';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** true면 백드롭/Escape/X 닫기를 막는다 (제출 중). */
  busy?: boolean;
}

/** 폼 다이얼로그 컨테이너 — 포커스 트랩 + Escape/백드롭 닫기 + 이전 포커스 복원. */
export const Modal = ({ open, title, onClose, children, footer, busy = false }: ModalProps) => {
  const titleID = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef({ busy, onClose });
  latestRef.current = { busy, onClose };

  // 최초 포커스는 open 시 1회만 — onClose/busy 참조는 ref로 고정해 재포커스(포커스 강탈) 방지.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !latestRef.current.busy) {
        event.preventDefault();
        latestRef.current.onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (nodes === undefined || nodes.length === 0) {
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className={styles.backdrop}
      onMouseDown={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleID}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className={styles.header}>
          <h2 id={titleID} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer !== undefined && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
};
