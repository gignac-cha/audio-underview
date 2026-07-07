import clsx from 'clsx';
import type { ReactNode } from 'react';
import { AppHeader } from './AppHeader.tsx';
import styles from './PageShell.module.css';

/**
 * 보호된 페이지 공통 레이아웃. `wide`면 에디터/스플릿뷰용 전폭, 아니면 중앙 정렬 컨테이너.
 */
export const PageShell = ({ children, wide = false }: { children: ReactNode; wide?: boolean }) => (
  <div className={styles.shell}>
    <AppHeader />
    <main className={clsx(styles.main, wide ? styles.wide : styles.contained)}>{children}</main>
  </div>
);
