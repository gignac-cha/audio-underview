import type { Crawler, CrawlerType } from '@audio-underview/schemas';
import { Badge } from '../../../components/Badge.tsx';
import { TextField } from '../../../components/FormControls.tsx';
import { Section } from '../../../components/Section.tsx';
import { formatDateTime } from '../../../tools/format.ts';
import type { FormState } from '../hooks/crawler-form-helpers.ts';
import styles from './DetailsSection.module.css';

export interface DetailsSectionProps {
  form: FormState;
  isEditable: boolean;
  crawlerType: CrawlerType;
  crawler: Crawler | undefined;
  autoFocusName: boolean;
  onNameChange: (value: string) => void;
  onURLPatternChange: (value: string) => void;
}

export const DetailsSection = ({
  form,
  isEditable,
  crawlerType,
  crawler,
  autoFocusName,
  onNameChange,
  onURLPatternChange,
}: DetailsSectionProps) => (
  <Section
    title="Details"
    actions={<Badge tone={crawlerType === 'web' ? 'accent' : 'info'}>{crawlerType}</Badge>}
  >
    <div className={styles.grid}>
      {isEditable ? (
        <TextField
          label="Name"
          value={form.name}
          autoFocus={autoFocusName}
          placeholder="My crawler"
          onChange={(event) => {
            onNameChange(event.target.value);
          }}
        />
      ) : (
        <div className={styles.readField}>
          <span className={styles.readLabel}>Name</span>
          <span className={styles.readValue}>{form.name}</span>
        </div>
      )}

      {crawlerType === 'web' &&
        (isEditable ? (
          <TextField
            label="URL pattern"
            value={form.url_pattern}
            placeholder="^https://example\.com"
            className={styles.mono}
            onChange={(event) => {
              onURLPatternChange(event.target.value);
            }}
          />
        ) : (
          <div className={styles.readField}>
            <span className={styles.readLabel}>URL pattern</span>
            <span className={styles.readMono}>{form.url_pattern || '—'}</span>
          </div>
        ))}

      {crawler !== undefined && (
        <div className={styles.timestamps}>
          <span>Created {formatDateTime(crawler.created_at)}</span>
          <span>Updated {formatDateTime(crawler.updated_at)}</span>
        </div>
      )}
    </div>
  </Section>
);
