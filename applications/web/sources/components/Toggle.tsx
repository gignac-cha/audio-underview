import clsx from 'clsx';
import styles from './Toggle.module.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

/** role=switch 토글 (스펙 §13 접근성 자산 보존). */
export const Toggle = ({ checked, onChange, label, disabled = false }: ToggleProps) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={clsx(styles.track, checked && styles.on)}
    onClick={() => {
      onChange(!checked);
    }}
  >
    <span className={styles.thumb} />
  </button>
);
