import type { Crawler } from '@audio-underview/schemas';
import { Badge } from '../../../components/Badge.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { formatDate } from '../../../tools/format.ts';
import styles from './CrawlerCard.module.css';

export interface CrawlerCardProps {
  crawler: Crawler;
  onOpen: () => void;
  onDelete: () => void;
}

export const CrawlerCard = ({ crawler, onOpen, onDelete }: CrawlerCardProps) => (
  <div
    className={styles.card}
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    }}
  >
    <div className={styles.top}>
      <Badge tone={crawler.type === 'web' ? 'accent' : 'info'}>{crawler.type}</Badge>
      <button
        type="button"
        className={styles.delete}
        aria-label={`Delete ${crawler.name}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
    <h2 className={styles.name}>{crawler.name}</h2>
    {crawler.url_pattern !== null && crawler.url_pattern.length > 0 && (
      <p className={styles.pattern}>{crawler.url_pattern}</p>
    )}
    <p className={styles.meta}>Created {formatDate(crawler.created_at)}</p>
  </div>
);
