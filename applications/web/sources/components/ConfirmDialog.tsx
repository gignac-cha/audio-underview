import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonVariant } from './Button.tsx';
import styles from './ConfirmDialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  /** 최초 포커스 대상 — 파괴적 확인은 안전한 Cancel에 두는 게 기본. */
  initialFocus?: 'confirm' | 'cancel';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 단일 확인 컴포넌트 (개선 §4) — 포커스 트랩 + Escape 취소 + 이전 포커스 복원.
 * 목록 삭제/에디터 discard/스테이지 삭제가 모두 이 컴포넌트를 공유한다.
 */
export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  initialFocus = 'cancel',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  const titleID = useId();
  const descriptionID = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const latestRef = useRef({ initialFocus, onCancel });
  latestRef.current = { initialFocus, onCancel };

  // 포커스/리스너 설정은 open 시 1회 — 콜백은 ref로 고정해 재렌더 시 포커스 강탈 방지.
  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target =
      latestRef.current.initialFocus === 'confirm' ? confirmRef.current : cancelRef.current;
    target?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        latestRef.current.onCancel();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled])',
      );
      if (focusable === undefined || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
    <div className={styles.backdrop} onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleID}
        aria-describedby={description === undefined ? undefined : descriptionID}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id={titleID} className={styles.title}>
          {title}
        </h2>
        {description !== undefined && (
          <p id={descriptionID} className={styles.description}>
            {description}
          </p>
        )}
        <div className={styles.actions}>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
