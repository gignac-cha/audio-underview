import type { ReactNode } from 'react';
import styles from './Section.module.css';

export interface SectionProps {
  title: string;
  /** 제목 옆 보조 텍스트 (예: 코드 카운터, "· running draft"). */
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}

/** "인스트루먼트 패널" 룩의 공통 섹션 카드 — micro-label 헤더 + 본문. */
export const Section = ({ title, hint, actions, children, padded = true }: SectionProps) => (
  <section className={styles.section}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <span className="micro-label">{title}</span>
        {hint !== undefined && <span className={styles.hint}>{hint}</span>}
      </div>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </header>
    <div className={padded ? styles.body : undefined}>{children}</div>
  </section>
);
