import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect } from 'react';
import { dismissToastAtom, toastsAtom, type ToastMessage } from '../state/toasts.ts';
import { Icon, type IconName } from './Icon.tsx';
import styles from './Toaster.module.css';

const TOAST_DURATION_MILLISECONDS = 5000;

const ICON_BY_TYPE: Record<ToastMessage['type'], IconName> = {
  success: 'check',
  error: 'alert',
  info: 'bolt',
};

const ToastItem = ({ toast }: { toast: ToastMessage }) => {
  const dismiss = useSetAtom(dismissToastAtom);

  useEffect(() => {
    const timer = setTimeout(() => {
      dismiss(toast.id);
    }, TOAST_DURATION_MILLISECONDS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast.id, dismiss]);

  return (
    <div className={styles.toast} data-type={toast.type} role="status">
      <span className={styles.icon}>
        <Icon name={ICON_BY_TYPE[toast.type]} size={16} />
      </span>
      <div className={styles.body}>
        <p className={styles.title}>{toast.title}</p>
        {toast.description !== undefined && (
          <p className={styles.description}>{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => {
          dismiss(toast.id);
        }}
        aria-label="Dismiss notification"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
};

/** 전역 토스트 렌더러 — aria-live 영역. */
export const Toaster = () => {
  const toasts = useAtomValue(toastsAtom);

  return (
    <div className={styles.viewport} aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
};
