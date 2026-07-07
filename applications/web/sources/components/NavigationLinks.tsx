import clsx from 'clsx';
import { NavLink } from 'react-router';
import { Icon, type IconName } from './Icon.tsx';
import styles from './Header.module.css';

const LINKS: { to: string; label: string; icon: IconName }[] = [
  { to: '/crawlers', label: 'Crawlers', icon: 'crawler' },
  { to: '/schedulers', label: 'Schedulers', icon: 'scheduler' },
];

export const NavigationLinks = () => (
  <nav className={styles.nav} aria-label="Primary">
    {LINKS.map((link) => (
      <NavLink
        key={link.to}
        to={link.to}
        className={({ isActive }) => clsx(styles.navLink, isActive && styles.navLinkActive)}
      >
        <Icon name={link.icon} size={16} />
        {link.label}
      </NavLink>
    ))}
  </nav>
);
