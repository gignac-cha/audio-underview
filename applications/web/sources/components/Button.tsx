import clsx from 'clsx';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'> {
  variant?: ButtonVariant;
  size?: 'small' | 'medium';
  iconLeft?: ReactNode;
  shortcutHint?: string;
  /**
   * 사유가 있으면 `aria-disabled`로 비활성 처리하고 클릭을 막되 포커스는 유지한다
   * (스펙 §10.13 aria-disabled + 사유 노출). native disabled와 구분.
   */
  disabledReason?: string;
  disabled?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'medium',
    iconLeft,
    shortcutHint,
    disabledReason,
    disabled = false,
    className,
    children,
    onClick,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isSoftDisabled = disabledReason !== undefined;

  return (
    <button
      ref={ref}
      type={type}
      className={clsx(styles.button, styles[variant], styles[size], className)}
      disabled={disabled}
      aria-disabled={isSoftDisabled || undefined}
      title={disabledReason}
      onClick={(event) => {
        if (isSoftDisabled) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...rest}
    >
      {iconLeft !== undefined && <span className={styles.icon}>{iconLeft}</span>}
      <span className={styles.label}>{children}</span>
      {shortcutHint !== undefined && <kbd className={styles.shortcut}>{shortcutHint}</kbd>}
      {isSoftDisabled && <span className="visually-hidden">{disabledReason}</span>}
    </button>
  );
});
