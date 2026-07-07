import { useNavigate } from 'react-router';
import { Icon, type IconName } from '../components/Icon.tsx';
import { PageShell } from '../components/PageShell.tsx';
import { useAuthentication } from '../features/authentication/use-authentication.ts';
import styles from './HomePage.module.css';

const TILES: { to: string; icon: IconName; title: string; description: string }[] = [
  {
    to: '/crawlers',
    icon: 'crawler',
    title: 'Crawlers',
    description: 'Author and test extraction scripts for web pages and structured data.',
  },
  {
    to: '/schedulers',
    icon: 'scheduler',
    title: 'Schedulers',
    description: 'Chain crawlers into pipelines and run them on a cron schedule.',
  },
];

export const HomePage = () => {
  const { user } = useAuthentication();
  const navigate = useNavigate();
  const firstName = user?.name.split(' ')[0] ?? 'there';

  return (
    <PageShell>
      <div className={styles.hero}>
        <p className="micro-label">Console</p>
        <h1 className={styles.greeting}>Welcome back, {firstName}.</h1>
        <p className={styles.subtitle}>Pick up where you left off.</p>
      </div>
      <div className={styles.tiles}>
        {TILES.map((tile) => (
          <button
            key={tile.to}
            type="button"
            className={styles.tile}
            onClick={() => {
              void navigate(tile.to);
            }}
          >
            <span className={styles.tileIcon}>
              <Icon name={tile.icon} size={22} />
            </span>
            <span className={styles.tileTitle}>{tile.title}</span>
            <span className={styles.tileDescription}>{tile.description}</span>
          </button>
        ))}
      </div>
    </PageShell>
  );
};
