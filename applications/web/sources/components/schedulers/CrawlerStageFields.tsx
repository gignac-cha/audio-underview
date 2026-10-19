import styled from '@emotion/styled';
import type { CrawlerRow, FanOutStrategy, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { useListCrawlers } from '../../hooks/use-crawler-manager.ts';
import { useToast } from '../../hooks/use-toast.ts';

const FieldGroup = styled.div`
  margin-bottom: 1rem;
`;

const FieldLabel = styled.label`
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
`;

const Select = styled.select`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: var(--transition-fast);

  &:focus {
    border-color: var(--border-focus);
  }

  option {
    background: var(--bg-deep);
    color: var(--text-primary);
  }
`;

const TextInput = styled.input`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--border-focus);
  }
`;

const TextArea = styled.textarea`
  width: 100%;
  min-height: 120px;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  outline: none;
  resize: vertical;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--border-focus);
  }
`;

const FieldHint = styled.p`
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 0.375rem 0 0 0;
`;

const ToggleRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
`;

const ToggleLink = styled.button`
  font-size: 0.75rem;
  color: var(--accent-primary);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;

  &:hover {
    text-decoration: underline;
  }
`;

const LoadMoreContainer = styled.div`
  display: flex;
  justify-content: center;
  margin-top: 0.5rem;
`;

const LoadMoreButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    border-color: var(--border-focus);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

export interface CrawlerStageValue {
  crawlerID: string;
  showJSON: boolean;
  schemaJSON: string;
  // The URL of the simple mode of a web crawler
  defaultURL: string;
  fanOutField: string;
  // Undefined until a strategy is chosen, so that a new stage leaves it to the server default
  fanOutStrategy: FanOutStrategy | undefined;
}

export type InputSchemaResult =
  | { ok: true; inputSchema: Record<string, unknown> }
  | { ok: false; error: string };

export const EMPTY_CRAWLER_STAGE_VALUE: CrawlerStageValue = {
  crawlerID: '',
  showJSON: false,
  schemaJSON: '{}',
  defaultURL: '',
  fanOutField: '',
  fanOutStrategy: undefined,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildDefaultSchema(crawler: CrawlerRow): Record<string, unknown> {
  if (crawler.type === 'web') {
    return { url: { type: 'string', default: '' } };
  }
  if (crawler.input_schema && Object.keys(crawler.input_schema).length > 0) {
    return crawler.input_schema;
  }
  return {};
}

function buildURLSchema(url: string): Record<string, unknown> {
  return { url: { type: 'string', default: url } };
}

/**
 * The URL of an input schema the simple mode of a web crawler would write, if it is one.
 */
function readSimpleURL(inputSchema: unknown): string | undefined {
  if (!isPlainObject(inputSchema) || Object.keys(inputSchema).length !== 1 || !isPlainObject(inputSchema.url)) {
    return undefined;
  }
  const { url } = inputSchema;
  if (Object.keys(url).length !== 2 || url.type !== 'string' || typeof url.default !== 'string') {
    return undefined;
  }
  return url.default;
}

/**
 * The fields filled with what the stage holds. A web crawler's schema opens in the simple mode
 * when that mode can show it, and the schema of a crawler that is not loaded opens as JSON.
 */
export function crawlerStageValueFromStage(stage: SchedulerStageRow, crawler: CrawlerRow | undefined): CrawlerStageValue {
  const simpleURL = readSimpleURL(stage.input_schema);
  return {
    crawlerID: stage.crawler_id ?? '',
    showJSON: crawler === undefined || (crawler.type === 'web' && simpleURL === undefined),
    schemaJSON: JSON.stringify(stage.input_schema, null, 2),
    defaultURL: simpleURL ?? '',
    fanOutField: stage.fan_out_field ?? '',
    fanOutStrategy: stage.fan_out_strategy,
  };
}

export function readInputSchema(value: CrawlerStageValue, crawler: CrawlerRow | undefined): InputSchemaResult {
  if (!value.showJSON && crawler?.type === 'web') {
    return { ok: true, inputSchema: buildURLSchema(value.defaultURL) };
  }
  try {
    return { ok: true, inputSchema: JSON.parse(value.schemaJSON) };
  } catch {
    return { ok: false, error: 'Invalid JSON in input schema.' };
  }
}

interface CrawlerStageFieldsProperties {
  value: CrawlerStageValue;
  onChange: (value: CrawlerStageValue) => void;
  disabled: boolean;
}

/**
 * The crawler of a stage, its input schema and how it fans out.
 */
export function CrawlerStageFields({ value, onChange, disabled }: CrawlerStageFieldsProperties) {
  const { showToast } = useToast();
  const { crawlers, hasNextPage, fetchNextPage, isFetchingNextPage } = useListCrawlers();

  const selectedCrawler = crawlers.find((crawler) => crawler.id === value.crawlerID);
  // A stage's crawler may sit on a page that is not loaded yet
  const isSelectedCrawlerListed = value.crawlerID === '' || selectedCrawler !== undefined;
  const hasFanOutField = value.fanOutField.trim().length > 0;

  const handleCrawlerChange = (crawlerID: string) => {
    const crawler = crawlers.find((candidate) => candidate.id === crawlerID);
    if (!crawler) {
      onChange({ ...value, crawlerID });
      return;
    }
    onChange({
      ...value,
      crawlerID,
      schemaJSON: JSON.stringify(buildDefaultSchema(crawler), null, 2),
      defaultURL: '',
      showJSON: false,
    });
  };

  const handleToggleJSON = () => {
    if (selectedCrawler?.type !== 'web') {
      onChange({ ...value, showJSON: !value.showJSON });
      return;
    }
    // The two modes of a web crawler show the same URL, so Simple mode refuses JSON it would drop
    if (value.showJSON) {
      let inputSchema: unknown;
      try {
        inputSchema = JSON.parse(value.schemaJSON);
      } catch {
        showToast('Validation Error', 'Invalid JSON in input schema.', 'error');
        return;
      }
      const simpleURL = readSimpleURL(inputSchema);
      if (simpleURL === undefined) {
        showToast('Validation Error', 'Simple mode shows only a URL, so it cannot show this input schema.', 'error');
        return;
      }
      onChange({ ...value, showJSON: false, defaultURL: simpleURL });
    } else {
      onChange({ ...value, showJSON: true, schemaJSON: JSON.stringify(buildURLSchema(value.defaultURL), null, 2) });
    }
  };

  return (
    <>
      <FieldGroup>
        <FieldLabel htmlFor="stage-crawler">Crawler</FieldLabel>
        <Select
          id="stage-crawler"
          value={value.crawlerID}
          onChange={(event) => handleCrawlerChange(event.target.value)}
          disabled={disabled}
        >
          <option value="">Select a crawler...</option>
          {!isSelectedCrawlerListed && (
            <option value={value.crawlerID}>{value.crawlerID.slice(0, 8) + '...'}</option>
          )}
          {crawlers.map((crawler) => (
            <option key={crawler.id} value={crawler.id}>
              {crawler.name} ({crawler.type})
            </option>
          ))}
        </Select>
        {hasNextPage && (
          <LoadMoreContainer>
            <LoadMoreButton type="button" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
              {isFetchingNextPage ? 'Loading...' : 'Load more crawlers'}
            </LoadMoreButton>
          </LoadMoreContainer>
        )}
      </FieldGroup>

      {value.crawlerID !== '' && (
        <>
          <FieldGroup>
            <ToggleRow>
              <FieldLabel htmlFor="stage-input-schema" style={{ marginBottom: 0 }}>Input Schema</FieldLabel>
              <ToggleLink type="button" onClick={handleToggleJSON}>
                {value.showJSON ? 'Simple mode' : 'Edit JSON'}
              </ToggleLink>
            </ToggleRow>
            {value.showJSON ? (
              <TextArea
                id="stage-input-schema"
                value={value.schemaJSON}
                onChange={(event) => onChange({ ...value, schemaJSON: event.target.value })}
                disabled={disabled}
                spellCheck={false}
              />
            ) : selectedCrawler?.type === 'web' ? (
              <TextInput
                id="stage-input-schema"
                placeholder="https://example.com"
                value={value.defaultURL}
                onChange={(event) => onChange({ ...value, defaultURL: event.target.value })}
                disabled={disabled}
              />
            ) : (
              <TextArea
                id="stage-input-schema"
                value={value.schemaJSON}
                onChange={(event) => onChange({ ...value, schemaJSON: event.target.value })}
                disabled={disabled}
                spellCheck={false}
                placeholder='{"key": {"type": "string", "default": "value"}}'
              />
            )}
          </FieldGroup>

          <FieldGroup>
            <FieldLabel htmlFor="stage-fan-out-field">Fan-out Field (optional)</FieldLabel>
            <TextInput
              id="stage-fan-out-field"
              placeholder="items"
              value={value.fanOutField}
              onChange={(event) => onChange({ ...value, fanOutField: event.target.value })}
              disabled={disabled}
            />
          </FieldGroup>

          {hasFanOutField && (
            <FieldGroup>
              <FieldLabel htmlFor="stage-fan-out-strategy">Fan-out Strategy</FieldLabel>
              <Select
                id="stage-fan-out-strategy"
                value={value.fanOutStrategy ?? 'compact'}
                onChange={(event) => onChange({ ...value, fanOutStrategy: event.target.value as FanOutStrategy })}
                disabled={disabled}
              >
                <option value="compact">Compact</option>
                <option value="preserve">Preserve</option>
              </Select>
              <FieldHint>Compact drops the results of failed items; Preserve keeps their place as null.</FieldHint>
            </FieldGroup>
          )}
        </>
      )}
    </>
  );
}
