import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faSignOutAlt,
  faArrowLeft,
  faArrowsRotate,
  faFloppyDisk,
  faXmark,
  faPen,
  faPlay,
  faPaperPlane,
  faFlask,
  faFlaskVial,
} from '@fortawesome/free-solid-svg-icons';
import { useParams } from 'react-router';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useCrawlerCodeRunner, type LogEntry } from '../hooks/use-crawler-code-runner.ts';
import { useCrawlerEditor, type EditorMode } from '../hooks/use-crawler-editor.ts';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton } from '../components/PageHeader.tsx';
import { CodeEditorPanel } from '../components/crawlers/CodeEditorPanel.tsx';
import { URLInputPanel } from '../components/crawlers/URLInputPanel.tsx';
import { JSONResultPanel } from '../components/crawlers/JSONResultPanel.tsx';
import { LogOverlay } from '../components/crawlers/LogOverlay.tsx';
import { DiscardDialog } from '../components/DiscardDialog.tsx';

const TEST_PANEL_STORAGE_KEY = 'crawler-editor:test-panel-open';

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const PageContainer = styled.div`
  min-height: 100vh;
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
`;

const TopBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
`;

const TopBarLeft = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  min-width: 0;
`;

const TopBarRight = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const BackButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const Title = styled.h1`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  @media (max-width: 600px) {
    max-width: 20ch;
  }
`;

const ModeBadge = styled('span', {
  shouldForwardProp: (prop) => prop !== 'mode',
})<{ mode: EditorMode }>`
  display: inline-flex;
  align-items: center;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: ${({ mode }) => (mode === 'view' ? 'var(--text-muted)' : 'var(--accent-primary)')};
  background: ${({ mode }) => (mode === 'view' ? 'transparent' : 'rgba(99, 102, 241, 0.12)')};
  border: 1px solid var(--border-subtle);
`;

const DirtyIndicator = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--accent-primary);
  animation: ${fadeIn} 200ms ease-out;

  &::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-primary);
  }
`;

const PrimaryButton = styled.button`
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
  transition: opacity 120ms ease;

  &:hover:not(:disabled):not([aria-disabled='true']) {
    opacity: 0.9;
  }

  &:disabled,
  &[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
`;

const GhostButton = styled.button`
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
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;

  &:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-deep);
    border-color: var(--border-focus);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const Grid = styled('div', {
  shouldForwardProp: (prop) => prop !== 'showTest',
})<{ showTest: boolean }>`
  flex: 1;
  display: grid;
  grid-template-columns: ${({ showTest }) => (showTest ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)')};
  gap: ${({ showTest }) => (showTest ? '1.25rem' : '0')};
  padding: 1.25rem;
  min-height: 0;
  transition: grid-template-columns 240ms ease, gap 240ms ease;

  @media (max-width: 900px) {
    grid-template-columns: 1fr;
  }
`;

const Column = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 0;
`;

const FormColumn = styled(Column)``;

const TestColumn = styled(Column)`
  animation: ${fadeIn} 200ms ease-out;
`;

const Section = styled.section`
  padding: 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const SectionHeader = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
`;

const SectionTitle = styled.h2`
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin: 0;
`;

const NameInput = styled.input`
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
  outline: none;
  width: 100%;
  transition: border-color 120ms ease;

  &:focus {
    border-color: var(--border-focus);
  }
`;

const MetaGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.5rem;
`;

const MetaItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
`;

const MetaLabel = styled.span`
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
`;

const FieldLabel = styled.label`
  display: block;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
`;

const MetaValue = styled.span`
  font-size: 0.8125rem;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  word-break: break-all;
`;

const TextInput = styled.input`
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.375rem 0.625rem;
  outline: none;
  font-family: var(--font-mono);
  transition: border-color 120ms ease;

  &:focus {
    border-color: var(--border-focus);
  }
`;

const TypeBadge = styled.span`
  display: inline-flex;
  width: fit-content;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--accent-primary);
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid var(--border-subtle);
`;

const SchemaArea = styled('textarea', {
  shouldForwardProp: (prop) => prop !== 'hasError',
})<{ hasError?: boolean }>`
  width: 100%;
  min-height: 100px;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid ${({ hasError }) => (hasError ? 'var(--color-error)' : 'var(--border-subtle)')};
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
  resize: vertical;
  outline: none;
  transition: border-color 120ms ease;

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

const ResultSection = styled(Section)`
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
`;

const TestBar = styled.div`
  display: flex;
  gap: 0.5rem;
  align-items: center;
`;

const LoadingContainer = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
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
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 4rem 1.5rem;
  text-align: center;
`;

const ShortcutHint = styled.span`
  font-size: 0.6875rem;
  color: var(--text-muted);
  font-family: var(--font-mono);
  margin-left: 0.25rem;

  @media (max-width: 600px) {
    display: none;
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

function isMacPlatform() {
  if (typeof navigator === 'undefined') return false;
  const agent = navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/.test(agent);
}

const MOD_LABEL = isMacPlatform() ? '⌘' : 'Ctrl';

function isShortcutMatch(event: KeyboardEvent, key: string) {
  const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
  return mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === key.toLowerCase();
}

function isFromFormElement(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function CrawlerEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { logout } = useAuthentication();
  const {
    mode,
    isCreateMode,
    isEditable,
    crawler,
    crawlerType,
    isLoading,
    error,
    refetch,
    form,
    setForm,
    schemaErrors,
    isDirty,
    canSubmit,
    disabledReason,
    isSaving,
    enterEdit,
    cancel,
    save,
    navigateBack,
    changeSchema,
    validateSchemaField,
    discardDialog,
  } = useCrawlerEditor(id);

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [testURL, setTestURL] = useState('');
  const [executionLogs, setExecutionLogs] = useState<LogEntry[]>([]);
  const [isLogOverlayOpen, setIsLogOverlayOpen] = useState(false);

  const [viewShowTest, setViewShowTest] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(TEST_PANEL_STORAGE_KEY) === 'open';
    } catch {
      return false;
    }
  });

  const showTest = mode === 'view' ? viewShowTest : true;

  const handleToggleTest = () => {
    if (mode !== 'view') return;
    setViewShowTest((previous) => {
      const next = !previous;
      try {
        window.localStorage.setItem(TEST_PANEL_STORAGE_KEY, next ? 'open' : 'closed');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const handleLog = useCallback((entry: LogEntry) => {
    setExecutionLogs((prev) => [...prev, entry]);
  }, []);

  const { runTest, status: runStatus, result: runResult, error: runError } = useCrawlerCodeRunner({ onLog: handleLog });
  const isRunning = runStatus === 'running';

  useEffect(() => {
    if (mode === 'edit' || mode === 'create') {
      nameInputRef.current?.focus();
    }
  }, [mode]);

  const handleRunTest = useCallback(() => {
    if (!form || !testURL || isRunning) return;
    runTest(testURL, form.code);
  }, [form, testURL, isRunning, runTest]);

  const onSaveShortcut = useEffectEvent(() => {
    if (!isEditable) return false;
    if (canSubmit && !isSaving) save();
    return true;
  });

  const onEditShortcut = useEffectEvent(() => {
    if (mode !== 'view') return false;
    enterEdit();
    return true;
  });

  const onRunShortcut = useEffectEvent(() => {
    if (!showTest || !testURL || isRunning) return false;
    handleRunTest();
    return true;
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (isShortcutMatch(event, 's')) {
        if (onSaveShortcut()) event.preventDefault();
        return;
      }
      if (isShortcutMatch(event, 'e') && !isFromFormElement(event)) {
        if (onEditShortcut()) event.preventDefault();
        return;
      }
      if (isShortcutMatch(event, 'Enter')) {
        if (onRunShortcut()) event.preventDefault();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const titleText = isCreateMode ? 'New Crawler' : form?.name ?? 'Loading…';
  const modeLabel = mode === 'create' ? 'Create' : mode === 'edit' ? 'Edit' : 'View';

  return (
    <PageContainer>
      <Header>
        <NavigationLinks />
        <LogoutButton onClick={logout}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign Out</span>
        </LogoutButton>
      </Header>

      <TopBar>
        <TopBarLeft>
          <BackButton onClick={navigateBack} aria-label="Back to crawlers">
            <FontAwesomeIcon icon={faArrowLeft} />
            Back
          </BackButton>
          <Title>{titleText}</Title>
          <ModeBadge mode={mode} aria-label={`Mode: ${modeLabel}`}>
            {modeLabel}
          </ModeBadge>
          {isDirty && isEditable && (
            <DirtyIndicator role="status" aria-live="polite" aria-label="Unsaved changes">
              Unsaved
            </DirtyIndicator>
          )}
        </TopBarLeft>
        <TopBarRight>
          {mode === 'view' && (
            <GhostButton onClick={handleToggleTest} aria-pressed={showTest} aria-label={showTest ? 'Hide test panel' : 'Show test panel'}>
              <FontAwesomeIcon icon={showTest ? faFlaskVial : faFlask} />
              {showTest ? 'Hide Test' : 'Show Test'}
            </GhostButton>
          )}
          {mode === 'create' && (
            <PrimaryButton
              onClick={() => {
                if (canSubmit && !isSaving) save();
              }}
              aria-disabled={!canSubmit || isSaving}
              aria-describedby={disabledReason ? 'crawler-submit-reason' : undefined}
              title={disabledReason}
            >
              <FontAwesomeIcon icon={faPaperPlane} />
              {isSaving ? 'Submitting…' : 'Submit'}
              <ShortcutHint>{MOD_LABEL}+S</ShortcutHint>
              {disabledReason && (
                <VisuallyHidden id="crawler-submit-reason">{disabledReason}</VisuallyHidden>
              )}
            </PrimaryButton>
          )}
          {mode === 'view' && crawler && form && (
            <PrimaryButton onClick={enterEdit} aria-label="Edit crawler">
              <FontAwesomeIcon icon={faPen} />
              Edit
              <ShortcutHint>{MOD_LABEL}+E</ShortcutHint>
            </PrimaryButton>
          )}
          {mode === 'edit' && crawler && form && (
            <>
              <GhostButton onClick={cancel} disabled={isSaving}>
                <FontAwesomeIcon icon={faXmark} />
                Cancel
              </GhostButton>
              <PrimaryButton
                onClick={() => {
                  if (canSubmit && !isSaving) save();
                }}
                aria-disabled={!canSubmit || isSaving}
                aria-describedby={disabledReason ? 'crawler-save-reason' : undefined}
                title={disabledReason}
              >
                <FontAwesomeIcon icon={faFloppyDisk} />
                {isSaving ? 'Saving…' : 'Save'}
                <ShortcutHint>{MOD_LABEL}+S</ShortcutHint>
                {disabledReason && (
                  <VisuallyHidden id="crawler-save-reason">{disabledReason}</VisuallyHidden>
                )}
              </PrimaryButton>
            </>
          )}
        </TopBarRight>
      </TopBar>

      {isLoading ? (
        <LoadingContainer role="status" aria-live="polite" aria-label="Loading crawler details">
          <Spinner aria-hidden="true" />
        </LoadingContainer>
      ) : error ? (
        <ErrorState>
          <p>Failed to load crawler.</p>
          <GhostButton onClick={() => refetch()}>
            <FontAwesomeIcon icon={faArrowsRotate} />
            Retry
          </GhostButton>
        </ErrorState>
      ) : form ? (
        <Grid showTest={showTest}>
          <FormColumn>
            <Section>
              <SectionHeader>
                <SectionTitle>Details</SectionTitle>
              </SectionHeader>
              {isEditable ? (
                <>
                  <FieldLabel htmlFor="crawler-name" style={{ marginBottom: '0.25rem' }}>
                    Crawler name
                  </FieldLabel>
                  <NameInput
                    id="crawler-name"
                    ref={nameInputRef}
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="Crawler name"
                  />
                </>
              ) : null}
              <MetaGrid style={{ marginTop: isEditable ? '0.75rem' : 0 }}>
                <MetaItem>
                  <MetaLabel>Type</MetaLabel>
                  <TypeBadge>{crawlerType}</TypeBadge>
                </MetaItem>
                {crawlerType === 'web' && (
                  <MetaItem>
                    {isEditable ? (
                      <>
                        <FieldLabel htmlFor="crawler-url-pattern">URL pattern</FieldLabel>
                        <TextInput
                          id="crawler-url-pattern"
                          value={form.url_pattern}
                          onChange={(event) => setForm({ ...form, url_pattern: event.target.value })}
                          placeholder="^https://example\.com"
                        />
                      </>
                    ) : (
                      <>
                        <MetaLabel>URL pattern</MetaLabel>
                        <MetaValue aria-label="URL pattern">{form.url_pattern}</MetaValue>
                      </>
                    )}
                  </MetaItem>
                )}
                {crawler && (
                  <>
                    <MetaItem>
                      <MetaLabel>Created</MetaLabel>
                      <MetaValue>{formatDateTime(crawler.created_at)}</MetaValue>
                    </MetaItem>
                    <MetaItem>
                      <MetaLabel>Updated</MetaLabel>
                      <MetaValue>{formatDateTime(crawler.updated_at)}</MetaValue>
                    </MetaItem>
                  </>
                )}
              </MetaGrid>
            </Section>

            <Section>
              <SectionHeader>
                <SectionTitle>Code</SectionTitle>
              </SectionHeader>
              <CodeEditorPanel
                value={form.code}
                onChange={(value) => setForm({ ...form, code: value })}
                disabled={!isEditable || isSaving}
                showDefaultTemplate={isCreateMode}
              />
            </Section>

            {!isCreateMode && (
              <Section>
                <SectionHeader>
                  <SectionTitle id="crawler-input-schema-label">Input schema</SectionTitle>
                </SectionHeader>
                <SchemaArea
                  value={form.input_schema}
                  onChange={(event) => changeSchema('input_schema', event.target.value)}
                  onBlur={
                    !isEditable || crawlerType === 'web'
                      ? undefined
                      : (event) => validateSchemaField('input_schema', event.target.value)
                  }
                  readOnly={!isEditable || crawlerType === 'web'}
                  hasError={!!schemaErrors.input_schema}
                  aria-labelledby="crawler-input-schema-label"
                  aria-invalid={!!schemaErrors.input_schema}
                  spellCheck={false}
                />
                <SchemaHelper isError={!!schemaErrors.input_schema}>
                  {schemaErrors.input_schema
                    ?? (crawlerType === 'web'
                      ? 'Web crawlers receive the fetched page body — schema is fixed and not editable.'
                      : 'Enter a JSON object describing the input this crawler expects.')}
                </SchemaHelper>
              </Section>
            )}

            {!isCreateMode && (
              <Section>
                <SectionHeader>
                  <SectionTitle id="crawler-output-schema-label">Output schema</SectionTitle>
                </SectionHeader>
                <SchemaArea
                  value={form.output_schema}
                  onChange={(event) => changeSchema('output_schema', event.target.value)}
                  onBlur={isEditable ? (event) => validateSchemaField('output_schema', event.target.value) : undefined}
                  readOnly={!isEditable}
                  hasError={!!schemaErrors.output_schema}
                  aria-labelledby="crawler-output-schema-label"
                  aria-invalid={!!schemaErrors.output_schema}
                  spellCheck={false}
                />
                {schemaErrors.output_schema && <SchemaHelper isError>{schemaErrors.output_schema}</SchemaHelper>}
              </Section>
            )}
          </FormColumn>

          {showTest && (
            <TestColumn>
              <Section>
                <SectionHeader>
                  <SectionTitle>
                    Test Runner
                    {isDirty && isEditable && <ShortcutHint>· running draft</ShortcutHint>}
                  </SectionTitle>
                  <GhostButton onClick={() => setIsLogOverlayOpen(true)} aria-label="Open logs">
                    Logs (
                    <span aria-live="polite" aria-atomic="true">{executionLogs.length}</span>
                    )
                  </GhostButton>
                </SectionHeader>
                <TestBar>
                  <URLInputPanel value={testURL} onChange={setTestURL} disabled={isRunning} />
                  <PrimaryButton onClick={handleRunTest} disabled={!testURL || isRunning}>
                    <FontAwesomeIcon icon={faPlay} />
                    {isRunning ? 'Running…' : 'Run'}
                    <ShortcutHint>{MOD_LABEL}+↵</ShortcutHint>
                  </PrimaryButton>
                </TestBar>
              </Section>
              <ResultSection>
                <SectionHeader>
                  <SectionTitle>Result</SectionTitle>
                </SectionHeader>
                <JSONResultPanel result={runResult} status={runStatus} error={runError} />
              </ResultSection>
            </TestColumn>
          )}
        </Grid>
      ) : null}

      <LogOverlay
        open={isLogOverlayOpen}
        onOpenChange={setIsLogOverlayOpen}
        entries={executionLogs}
        onClear={() => setExecutionLogs([])}
      />

      <DiscardDialog {...discardDialog} />
    </PageContainer>
  );
}
