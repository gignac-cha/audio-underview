import clsx from 'clsx';
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'error' | 'info' | 'warning';

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
}

export const Badge = ({ tone = 'neutral', dot = false, children }: BadgeProps) => (
  <span className={clsx(styles.badge, styles[tone])}>
    {dot && <span className={styles.dot} />}
    {children}
  </span>
);
