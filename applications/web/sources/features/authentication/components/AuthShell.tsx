import type { ReactNode } from 'react';
import { Icon } from '../../../components/Icon.tsx';
import { ThemeToggle } from '../../../components/ThemeToggle.tsx';
import styles from './AuthShell.module.css';

/** 인증 화면 공통 레이아웃 — 중앙 카드 + 브랜드 + 배경 텍스처. */
export const AuthShell = ({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) => (
  <div className={styles.page}>
    <div className={styles.themeToggle}>
      <ThemeToggle />
    </div>
    <div className={styles.card}>
      <span className={styles.mark}>
        <Icon name="crawler" size={26} />
      </span>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.subtitle}>{subtitle}</p>
      <div className={styles.content}>{children}</div>
    </div>
    <p className={styles.brand}>audio-underview</p>
  </div>
);
