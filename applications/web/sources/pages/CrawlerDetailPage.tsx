import { useEffect, useMemo, useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt, faArrowLeft, faArrowsRotate, faFloppyDisk, faRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { useParams, useNavigate } from 'react-router';
import type { CrawlerRow } from '@audio-underview/supabase-connector';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useGetCrawler, useUpdateCrawler } from '../hooks/use-crawler-manager.ts';
import { useToast } from '../hooks/use-toast.ts';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton } from '../components/PageHeader.tsx';
import { CodeEditorPanel } from '../components/crawlers/CodeEditorPanel.tsx';

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const PageContainer = styled.div`
  min-height: 100vh;
  background: var(--bg-deep);
`;

const Main = styled.main`
  padding: 2rem 1.5rem;
  max-width: 960px;
  margin: 0 auto;
  animation: ${fadeIn} 0.4s ease-out;
`;

const BackButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);
  margin-bottom: 1.25rem;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
`;

const LoadingContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
`;

const Spinner = styled.div`
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-subtle);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: ${spin} 0.8s linear infinite;
`;

const ErrorState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
  text-align: center;
`;

const ErrorMessage = styled.p`
  font-size: 1rem;
  color: var(--text-muted);
  margin: 0 0 1.5rem 0;
`;

const RetryButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    border-color: var(--border-focus);
  }
`;

const Section = styled.section`
  margin-bottom: 1.5rem;
  padding: 1.25rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
`;

const SectionTitle = styled.h2`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0;
`;

const NameInput = styled.input`
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  outline: none;
  width: 100%;
  margin-bottom: 1rem;

  &:focus {
    border-color: var(--border-focus);
  }
`;

const MetaGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
`;

const MetaItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const MetaLabel = styled.span`
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const MetaValue = styled.span`
  font-size: 0.875rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-all;
`;

const TextInput = styled.input`
  font-size: 0.875rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.375rem 0.625rem;
  outline: none;
  font-family: var(--font-mono);

  &:focus {
    border-color: var(--border-focus);
  }
`;

const TypeBadge = styled.span`
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent-primary);
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid var(--border-subtle);
`;

const SchemaArea = styled('textarea', {
  shouldForwardProp: (prop) => prop !== 'hasError',
})<{ hasError?: boolean }>`
  width: 100%;
  min-height: 120px;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid ${({ hasError }) => (hasError ? 'var(--color-error)' : 'var(--border-subtle)')};
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
  resize: vertical;
  outline: none;

  &:focus {
    border-color: ${({ hasError }) => (hasError ? 'var(--color-error)' : 'var(--border-focus)')};
  }

  &:read-only {
    color: var(--text-muted);
    cursor: not-allowed;
  }
`;

const SchemaHelper = styled('span', {
  shouldForwardProp: (prop) => prop !== 'isError',
})<{ isError?: boolean }>`
  display: block;
  margin-top: 0.375rem;
  font-size: 0.75rem;
  color: ${({ isError }) => (isError ? 'var(--color-error)' : 'var(--text-muted)')};
`;

const ActionRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
`;

const SaveButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const RevertButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-deep);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function stringifySchema(schema: Record<string, unknown>) {
  return JSON.stringify(schema, null, 2);
}

interface FormState {
  name: string;
  url_pattern: string;
  code: string;
  input_schema: string;
  output_schema: string;
}

function deriveFormState(crawler: CrawlerRow): FormState {
  return {
    name: crawler.name,
    url_pattern: crawler.url_pattern ?? '',
    code: crawler.code,
    input_schema: stringifySchema(crawler.input_schema),
    output_schema: stringifySchema(crawler.output_schema),
  };
}

function tryParseSchema(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === undefined || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface SchemaErrors {
  input_schema?: string;
  output_schema?: string;
}

export function CrawlerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { logout } = useAuthentication();
  const { showToast } = useToast();
  const { crawler, isLoading, error, refetch } = useGetCrawler(id);
  const { updateCrawler, status: updateStatus } = useUpdateCrawler();

  const [form, setForm] = useState<FormState | undefined>(undefined);
  const [pristine, setPristine] = useState<FormState | undefined>(undefined);
  const [schemaErrors, setSchemaErrors] = useState<SchemaErrors>({});

  useEffect(() => {
    if (crawler && !form) {
      const initial = deriveFormState(crawler);
      setForm(initial);
      setPristine(initial);
    }
  }, [crawler, form]);

  const isDirty = useMemo(() => {
    if (!form || !pristine) return false;
    return (
      form.name !== pristine.name ||
      form.url_pattern !== pristine.url_pattern ||
      form.code !== pristine.code ||
      form.input_schema !== pristine.input_schema ||
      form.output_schema !== pristine.output_schema
    );
  }, [form, pristine]);

  const hasSchemaError = !!schemaErrors.input_schema || !!schemaErrors.output_schema;
  const trimmedName = form?.name.trim() ?? '';
  const canSave =
    !!form &&
    isDirty &&
    !hasSchemaError &&
    trimmedName.length > 0 &&
    form.code.trim().length > 0 &&
    (crawler?.type === 'data' || form.url_pattern.trim().length > 0);

  const isSaving = updateStatus === 'pending';

  const handleRevert = () => {
    if (pristine) {
      setForm(pristine);
      setSchemaErrors({});
    }
  };

  const validateSchemaField = (field: 'input_schema' | 'output_schema', raw: string) => {
    setSchemaErrors((previous) => {
      const next = { ...previous };
      const parsed = tryParseSchema(raw);
      if (parsed === undefined) {
        next[field] = 'Must be a valid JSON object.';
      } else {
        delete next[field];
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!crawler || !form) return;

    const parsedInputSchema = tryParseSchema(form.input_schema);
    const parsedOutputSchema = tryParseSchema(form.output_schema);

    if (parsedInputSchema === undefined) {
      setSchemaErrors((previous) => ({ ...previous, input_schema: 'Must be a valid JSON object.' }));
      showToast('Error', 'Input schema is not valid JSON.', 'error');
      return;
    }
    if (parsedOutputSchema === undefined) {
      setSchemaErrors((previous) => ({ ...previous, output_schema: 'Must be a valid JSON object.' }));
      showToast('Error', 'Output schema is not valid JSON.', 'error');
      return;
    }

    if (!trimmedName) {
      showToast('Error', 'Name cannot be empty.', 'error');
      return;
    }

    if (!form.code.trim()) {
      showToast('Error', 'Code cannot be empty.', 'error');
      return;
    }

    if (crawler.type === 'web' && !form.url_pattern.trim()) {
      showToast('Error', 'URL pattern cannot be empty for web crawlers.', 'error');
      return;
    }

    try {
      const payload =
        crawler.type === 'data'
          ? {
              id: crawler.id,
              type: 'data' as const,
              name: trimmedName,
              code: form.code,
              input_schema: parsedInputSchema,
              output_schema: parsedOutputSchema,
            }
          : {
              id: crawler.id,
              type: 'web' as const,
              name: trimmedName,
              url_pattern: form.url_pattern,
              code: form.code,
              output_schema: parsedOutputSchema,
            };

      const updated = await updateCrawler(payload);
      const next = deriveFormState(updated);
      setForm(next);
      setPristine(next);
      showToast('Saved', `Crawler "${trimmedName}" has been updated.`, 'success');
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Failed to save crawler';
      showToast('Error', message, 'error');
    }
  };

  return (
    <PageContainer>
      <Header>
        <NavigationLinks />
        <LogoutButton onClick={logout}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign Out</span>
        </LogoutButton>
      </Header>

      <Main>
        <BackButton onClick={() => navigate('/crawlers')}>
          <FontAwesomeIcon icon={faArrowLeft} />
          Back to Crawlers
        </BackButton>

        {isLoading ? (
          <LoadingContainer>
            <Spinner />
          </LoadingContainer>
        ) : error ? (
          <ErrorState>
            <ErrorMessage>Failed to load crawler.</ErrorMessage>
            <RetryButton onClick={() => refetch()}>
              <FontAwesomeIcon icon={faArrowsRotate} />
              Retry
            </RetryButton>
          </ErrorState>
        ) : crawler && form ? (
          <>
            <Section>
              <NameInput
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                aria-label="Crawler name"
                placeholder="Crawler name"
              />
              <MetaGrid>
                <MetaItem>
                  <MetaLabel>Type</MetaLabel>
                  <TypeBadge>{crawler.type}</TypeBadge>
                </MetaItem>
                {crawler.type === 'web' && (
                  <MetaItem>
                    <MetaLabel>URL Pattern</MetaLabel>
                    <TextInput
                      value={form.url_pattern}
                      onChange={(event) => setForm({ ...form, url_pattern: event.target.value })}
                      aria-label="URL pattern"
                      placeholder="^https://example\.com"
                    />
                  </MetaItem>
                )}
                <MetaItem>
                  <MetaLabel>Created</MetaLabel>
                  <MetaValue>{formatDateTime(crawler.created_at)}</MetaValue>
                </MetaItem>
                <MetaItem>
                  <MetaLabel>Updated</MetaLabel>
                  <MetaValue>{formatDateTime(crawler.updated_at)}</MetaValue>
                </MetaItem>
              </MetaGrid>
            </Section>

            <Section>
              <SectionHeader>
                <SectionTitle>Code</SectionTitle>
              </SectionHeader>
              <CodeEditorPanel
                value={form.code}
                onChange={(value) => setForm({ ...form, code: value })}
                disabled={isSaving}
                showDefaultTemplate={false}
              />
            </Section>

            <Section>
              <SectionHeader>
                <SectionTitle>Input Schema</SectionTitle>
              </SectionHeader>
              <SchemaArea
                value={form.input_schema}
                onChange={(event) => setForm({ ...form, input_schema: event.target.value })}
                onBlur={
                  crawler.type === 'web'
                    ? undefined
                    : (event) => validateSchemaField('input_schema', event.target.value)
                }
                readOnly={crawler.type === 'web'}
                hasError={!!schemaErrors.input_schema}
                aria-label="Input schema"
                aria-invalid={!!schemaErrors.input_schema}
                spellCheck={false}
              />
              <SchemaHelper isError={!!schemaErrors.input_schema}>
                {schemaErrors.input_schema
                  ?? (crawler.type === 'web'
                    ? 'Web crawlers receive the fetched page body — schema is fixed and not editable.'
                    : 'Enter a JSON object describing the input this crawler expects.')}
              </SchemaHelper>
            </Section>

            <Section>
              <SectionHeader>
                <SectionTitle>Output Schema</SectionTitle>
              </SectionHeader>
              <SchemaArea
                value={form.output_schema}
                onChange={(event) => setForm({ ...form, output_schema: event.target.value })}
                onBlur={(event) => validateSchemaField('output_schema', event.target.value)}
                hasError={!!schemaErrors.output_schema}
                aria-label="Output schema"
                aria-invalid={!!schemaErrors.output_schema}
                spellCheck={false}
              />
              {schemaErrors.output_schema && (
                <SchemaHelper isError>{schemaErrors.output_schema}</SchemaHelper>
              )}
            </Section>

            <ActionRow>
              <RevertButton onClick={handleRevert} disabled={!isDirty || isSaving}>
                <FontAwesomeIcon icon={faRotateLeft} />
                Revert
              </RevertButton>
              <SaveButton onClick={handleSave} disabled={!canSave || isSaving}>
                <FontAwesomeIcon icon={faFloppyDisk} />
                {isSaving ? 'Saving...' : 'Save'}
              </SaveButton>
            </ActionRow>
          </>
        ) : null}
      </Main>
    </PageContainer>
  );
}
