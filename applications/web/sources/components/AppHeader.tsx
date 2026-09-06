import { useNavigate } from 'react-router';
import { useAuthentication } from '../features/authentication/use-authentication.ts';
import { Icon } from './Icon.tsx';
import { NavigationLinks } from './NavigationLinks.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { UserAvatar } from './UserAvatar.tsx';
import styles from './Header.module.css';

/** 보호된 페이지 공통 상단 바 (GNB + 테마 + 계정). */
export const AppHeader = () => {
  const { user, signOut } = useAuthentication();
  const navigate = useNavigate();

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.left}>
          <span className={styles.brand}>
            <span className={styles.brandMark}>
              <Icon name="crawler" size={18} />
            </span>
            <span className={styles.brandName}>audio-underview</span>
          </span>
          <NavigationLinks />
        </div>
        <div className={styles.right}>
          <ThemeToggle />
          {user !== null && (
            <>
              <UserAvatar user={user} />
              <button
                type="button"
                className={styles.iconButton}
                onClick={() => {
                  signOut();
                  void navigate('/sign/in', { replace: true });
                }}
                aria-label="Sign out"
                title="Sign out"
              >
                <Icon name="signOut" size={17} />
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
