import { useAtom } from 'jotai';
import { themeAtom } from '../state/theme.ts';
import { Icon } from './Icon.tsx';
import styles from './Header.module.css';

/** 라이트/다크 테마 토글 — themeAtom 단일 소스(<html data-theme> + localStorage). */
export const ThemeToggle = () => {
  const [theme, setTheme] = useAtom(themeAtom);
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className={styles.iconButton}
      onClick={() => {
        setTheme(next);
      }}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
    </button>
  );
};
