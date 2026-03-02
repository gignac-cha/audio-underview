import { useState, useMemo } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useToast } from '../../hooks/use-toast.ts';
import { useCreateStage } from '../../hooks/use-scheduler-manager.ts';
import { useListCrawlers } from '../../hooks/use-crawler-manager.ts';
import type { CrawlerRow } from '@audio-underview/supabase-connector';

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
`;

const Content = styled(Dialog.Content)`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 101;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.5rem;
  width: 90vw;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: var(--shadow-md);
`;

const Title = styled(Dialog.Title)`
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 1rem 0;
`;

const Description = styled(Dialog.Description)`
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0 0 1.25rem 0;
  line-height: 1.5;
`;

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

const ButtonRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
`;

const CancelButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const Spinner = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: ${spin} 0.6s linear infinite;
`;

const SubmitButton = styled('button', {
  shouldForwardProp: (prop) => prop !== 'isSubmitting',
})<{ isSubmitting?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: ${({ isSubmitting }) => (isSubmitting ? 'not-allowed' : 'pointer')};
  opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 1)};
  transition: var(--transition-fast);

  &:hover {
    opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 0.9)};
  }
`;

interface StageCreateDialogProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedulerID: string;
  nextOrder: number;
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

export function StageCreateDialog({ open, onOpenChange, schedulerID, nextOrder }: StageCreateDialogProperties) {
  const { showToast } = useToast();
  const { createStage, status } = useCreateStage();
  const { crawlers, hasNextPage, fetchNextPage, isFetchingNextPage } = useListCrawlers();

  const [selectedCrawlerID, setSelectedCrawlerID] = useState('');
  const [fanOutField, setFanOutField] = useState('');
  const [showJSON, setShowJSON] = useState(false);
  const [schemaJSON, setSchemaJSON] = useState('{}');
  const [defaultURL, setDefaultURL] = useState('');

  const isSubmitting = status === 'pending';

  const selectedCrawler = useMemo(
    () => crawlers.find((crawler) => crawler.id === selectedCrawlerID) ?? null,
    [crawlers, selectedCrawlerID],
  );

  const handleCrawlerChange = (crawlerID: string) => {
    setSelectedCrawlerID(crawlerID);
    const crawler = crawlers.find((c) => c.id === crawlerID);
    if (crawler) {
      const schema = buildDefaultSchema(crawler);
      setSchemaJSON(JSON.stringify(schema, null, 2));
      setDefaultURL('');
      setShowJSON(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isSubmitting) return;
    if (!nextOpen) {
      setSelectedCrawlerID('');
      setFanOutField('');
      setShowJSON(false);
      setSchemaJSON('{}');
      setDefaultURL('');
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    if (!selectedCrawlerID) {
      showToast('Validation Error', 'Please select a crawler.', 'error');
      return;
    }

    let inputSchema: Record<string, unknown>;
    if (showJSON) {
      try {
        inputSchema = JSON.parse(schemaJSON);
      } catch {
        showToast('Validation Error', 'Invalid JSON in input schema.', 'error');
        return;
      }
    } else if (selectedCrawler?.type === 'web') {
      inputSchema = { url: { type: 'string', default: defaultURL ?? '' } };
    } else {
      try {
        inputSchema = JSON.parse(schemaJSON);
      } catch {
        showToast('Validation Error', 'Invalid JSON in input schema.', 'error');
        return;
      }
    }

    try {
      await createStage({
        scheduler_id: schedulerID,
        crawler_id: selectedCrawlerID,
        stage_order: nextOrder,
        input_schema: inputSchema,
        fan_out_field: (() => { const trimmed = fanOutField.trim(); return trimmed.length > 0 ? trimmed : undefined; })(),
      });
      showToast('Success', 'Stage added to pipeline.', 'success');
      handleOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create stage';
      showToast('Error', message, 'error');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <Title>Add Stage</Title>
          <Description>Add a crawler as a new stage in this pipeline.</Description>

          <FieldGroup>
            <FieldLabel htmlFor="stage-crawler">Crawler</FieldLabel>
            <Select
              id="stage-crawler"
              value={selectedCrawlerID}
              onChange={(event) => handleCrawlerChange(event.target.value)}
              disabled={isSubmitting}
            >
              <option value="">Select a crawler...</option>
              {crawlers.map((crawler) => (
                <option key={crawler.id} value={crawler.id}>
                  {crawler.name} ({crawler.type})
                </option>
              ))}
            </Select>
            {hasNextPage && (
              <LoadMoreContainer>
                <LoadMoreButton onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? 'Loading...' : 'Load more crawlers'}
                </LoadMoreButton>
              </LoadMoreContainer>
            )}
          </FieldGroup>

          {selectedCrawler && (
            <>
              <FieldGroup>
                <ToggleRow>
                  <FieldLabel htmlFor="stage-input-schema" style={{ marginBottom: 0 }}>Input Schema</FieldLabel>
                  <ToggleLink onClick={() => setShowJSON(!showJSON)}>
                    {showJSON ? 'Simple mode' : 'Edit JSON'}
                  </ToggleLink>
                </ToggleRow>
                {showJSON ? (
                  <TextArea
                    id="stage-input-schema"
                    value={schemaJSON}
                    onChange={(event) => setSchemaJSON(event.target.value)}
                    disabled={isSubmitting}
                    spellCheck={false}
                  />
                ) : selectedCrawler.type === 'web' ? (
                  <TextInput
                    id="stage-input-schema"
                    placeholder="https://example.com"
                    value={defaultURL}
                    onChange={(event) => setDefaultURL(event.target.value)}
                    disabled={isSubmitting}
                  />
                ) : (
                  <TextArea
                    id="stage-input-schema"
                    value={schemaJSON}
                    onChange={(event) => setSchemaJSON(event.target.value)}
                    disabled={isSubmitting}
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
                  value={fanOutField}
                  onChange={(event) => setFanOutField(event.target.value)}
                  disabled={isSubmitting}
                />
              </FieldGroup>
            </>
          )}

          <ButtonRow>
            <Dialog.Close asChild>
              <CancelButton disabled={isSubmitting}>Cancel</CancelButton>
            </Dialog.Close>
            <SubmitButton onClick={handleSubmit} disabled={isSubmitting || !selectedCrawlerID} isSubmitting={isSubmitting}>
              {isSubmitting && <Spinner />}
              {isSubmitting ? 'Adding...' : 'Add Stage'}
            </SubmitButton>
          </ButtonRow>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
