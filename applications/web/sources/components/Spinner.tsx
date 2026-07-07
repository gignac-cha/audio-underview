import styles from './Spinner.module.css';

export interface SpinnerProps {
  size?: number;
  label?: string;
}

/** 접근성 있는 로딩 스피너 — label은 aria-live 영역으로 노출. */
export const Spinner = ({ size = 20, label }: SpinnerProps) => (
  <span className={styles.wrapper} role="status">
    <span
      className={styles.spinner}
      style={{ width: `${String(size)}px`, height: `${String(size)}px` }}
    />
    {label === undefined ? (
      <span className="visually-hidden">Loading</span>
    ) : (
      <span className={styles.label}>{label}</span>
    )}
  </span>
);
