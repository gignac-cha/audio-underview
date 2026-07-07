import type { ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Icon, type IconName } from './Icon.tsx';
import styles from './ListPage.module.css';
import { Spinner } from './Spinner.tsx';

export interface ListPageProps<Item> {
  title: string;
  icon: IconName;
  createLabel: string;
  onCreate: () => void;
  items: Item[];
  isLoading: boolean;
  error?: Error;
  onRetry: () => void;
  errorMessage: string;
  emptyTitle: string;
  emptyDescription: string;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  renderItem: (item: Item) => ReactNode;
  getItemKey: (item: Item) => string;
}

/**
 * 목록 페이지 공통 추상화 (개선 §3) — loading / error+Retry / empty CTA / grid / Load More.
 * Crawlers·Schedulers가 이 컴포넌트를 공유해 복붙을 제거한다 (보존 §11).
 */
export const ListPage = <Item,>({
  title,
  icon,
  createLabel,
  onCreate,
  items,
  isLoading,
  error,
  onRetry,
  errorMessage,
  emptyTitle,
  emptyDescription,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  renderItem,
  getItemKey,
}: ListPageProps<Item>) => {
  const showEmpty = !isLoading && error === undefined && items.length === 0;

  return (
    <section>
      <header className={styles.pageHeader}>
        <div className={styles.heading}>
          <span className={styles.headingIcon}>
            <Icon name={icon} size={20} />
          </span>
          <h1 className={styles.title}>{title}</h1>
        </div>
        <Button variant="primary" iconLeft={<Icon name="plus" size={16} />} onClick={onCreate}>
          {createLabel}
        </Button>
      </header>

      {isLoading && items.length === 0 && (
        <div className={styles.centered}>
          <Spinner size={26} label="Loading…" />
        </div>
      )}

      {error !== undefined && (
        <div className={styles.state} role="alert">
          <span className={styles.stateIcon} data-tone="error">
            <Icon name="alert" size={22} />
          </span>
          <p className={styles.stateTitle}>{errorMessage}</p>
          <p className={styles.stateDescription}>{error.message}</p>
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}

      {showEmpty && (
        <div className={styles.state}>
          <span className={styles.stateIcon}>
            <Icon name={icon} size={26} />
          </span>
          <p className={styles.stateTitle}>{emptyTitle}</p>
          <p className={styles.stateDescription}>{emptyDescription}</p>
          <Button variant="primary" iconLeft={<Icon name="plus" size={16} />} onClick={onCreate}>
            {createLabel}
          </Button>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className={styles.grid}>
            {items.map((item) => (
              <div key={getItemKey(item)}>{renderItem(item)}</div>
            ))}
          </div>
          {hasNextPage && onLoadMore !== undefined && (
            <div className={styles.loadMore}>
              <Button
                variant="secondary"
                onClick={onLoadMore}
                disabled={isFetchingNextPage}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load More'}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export const ListStateMessage = ({ children }: { children: ReactNode }) => (
  <p className={styles.inlineState}>{children}</p>
);
