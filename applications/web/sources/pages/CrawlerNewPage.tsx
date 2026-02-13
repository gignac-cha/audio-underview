import { useState, useCallback } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faPlay, faPaperPlane, faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import { useCrawlerCodeRunner, type LogEntry } from '../hooks/use-crawler-code-runner.ts';
import { useMediaQuery } from '../hooks/use-media-query.ts';
import { URLInputPanel } from '../components/crawlers/URLInputPanel.tsx';
import { CodeEditorPanel, DEFAULT_CODE } from '../components/crawlers/CodeEditorPanel.tsx';
import { JSONResultPanel } from '../components/crawlers/JSONResultPanel.tsx';
import { LogOverlay } from '../components/crawlers/LogOverlay.tsx';
import { CrawlerSubmissionDialog } from '../components/crawlers/CrawlerSubmissionDialog.tsx';

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const PageContainer = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-deep);
`;

const Header = styled.header`
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.5rem;
  background: rgba(10, 10, 10, 0.9);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-subtle);
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
`;

const BackButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
`;

const PageTitle = styled.h1`
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
`;

const LogoutButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  span {
    display: none;

    @media (min-width: 640px) {
      display: inline;
    }
  }
`;

const Main = styled.main`
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 1.25rem;
  gap: 1.25rem;
  animation: ${fadeIn} 0.4s ease-out;
  overflow: hidden;
`;

const GridLayout = styled.div`
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
  min-height: 0;
`;

const Column = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-height: 0;
`;

const MobileTabBar = styled.div`
  display: flex;
  gap: 0;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  overflow: hidden;
`;

const MobileTab = styled('button', {
  shouldForwardProp: (prop) => prop !== 'isActive',
})<{ isActive: boolean }>`
  flex: 1;
  padding: 0.5rem;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition-fast);
  color: ${({ isActive }) => (isActive ? 'var(--text-primary)' : 'var(--text-muted)')};
  background: ${({ isActive }) => (isActive ? 'var(--bg-surface)' : 'transparent')};
  border-right: 1px solid var(--border-subtle);

  &:last-child {
    border-right: none;
  }
`;

const MobilePanel = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
`;

const ActionBar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 0.5rem;
`;

const ActionLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const LogButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    border-color: var(--text-muted);
    color: var(--text-primary);
  }
`;

const LogBadge = styled.span`
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  padding: 0.0625rem 0.4375rem;
  border-radius: 9999px;
  min-width: 1.25rem;
  text-align: center;
  line-height: 1.4;
`;

const spin = keyframes`
  to { transform: rotate(360deg); }
`;

const ButtonSpinner = styled.span`
  display: inline-block;
  width: 0.875rem;
  height: 0.875rem;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: ${spin} 0.6s linear infinite;
`;

const TestButton = styled.button<{ isRunning?: boolean }>`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;

const SubmitButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.625rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;

type MobileTabID = 'editor' | 'result';

export function CrawlerNewPage() {
  const navigate = useNavigate();
  const { logout } = useAuthentication();

  const [url, setURL] = useState('');
  const [code, setCode] = useState('');
  const [executionLogs, setExecutionLogs] = useState<LogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<MobileTabID>('editor');
  const [isLogOverlayOpen, setIsLogOverlayOpen] = useState(false);
  const [isSubmitDialogOpen, setIsSubmitDialogOpen] = useState(false);

  const handleLog = useCallback((entry: LogEntry) => {
    setExecutionLogs((previous) => [...previous, entry]);
  }, []);

  const { runTest, status, result, error } = useCrawlerCodeRunner({ onLog: handleLog });

  const isDesktop = useMediaQuery('(min-width: 768px)');
  const isRunning = status === 'running';
  const effectiveCode = code.length > 0 ? code : DEFAULT_CODE;

  const canTest = url.length > 0 && effectiveCode.length > 0 && !isRunning;
  const canSubmit = status === 'success';

  const isValidURL = (() => {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  })();

  const handleTest = () => {
    if (!canTest || !isValidURL) return;
    runTest(url, effectiveCode);
  };

  const handleClearLogs = () => {
    setExecutionLogs([]);
  };


  return (
    <PageContainer>
      <Header>
        <HeaderLeft>
          <BackButton onClick={() => navigate('/home')}>
            <FontAwesomeIcon icon={faArrowLeft} />
            Home
          </BackButton>
          <PageTitle>New Crawler</PageTitle>
        </HeaderLeft>

        <LogoutButton onClick={logout}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign Out</span>
        </LogoutButton>
      </Header>

      <Main>
        {isDesktop ? (
          <GridLayout>
            <Column>
              <URLInputPanel value={url} onChange={setURL} disabled={isRunning} />
              <CodeEditorPanel value={code} onChange={setCode} disabled={isRunning} />
            </Column>
            <Column>
              <JSONResultPanel result={result} status={status} error={error} />
            </Column>
          </GridLayout>
        ) : (
          <>
            <MobileTabBar>
              <MobileTab isActive={activeTab === 'editor'} onClick={() => setActiveTab('editor')}>
                Editor
              </MobileTab>
              <MobileTab isActive={activeTab === 'result'} onClick={() => setActiveTab('result')}>
                Result
              </MobileTab>
            </MobileTabBar>
            <MobilePanel>
              {activeTab === 'editor' && (
                <Column>
                  <URLInputPanel value={url} onChange={setURL} disabled={isRunning} />
                  <CodeEditorPanel value={code} onChange={setCode} disabled={isRunning} />
                </Column>
              )}
              {activeTab === 'result' && (
                <JSONResultPanel result={result} status={status} error={error} />
              )}
            </MobilePanel>
          </>
        )}

        <ActionBar>
          <ActionLeft>
            <TestButton disabled={!canTest || !isValidURL} onClick={handleTest} isRunning={isRunning}>
              {isRunning ? <ButtonSpinner /> : <FontAwesomeIcon icon={faPlay} />}
              {isRunning ? 'Running...' : 'Test'}
            </TestButton>
            <LogButton onClick={() => setIsLogOverlayOpen(true)}>
              Log
              {executionLogs.length > 0 && <LogBadge>{executionLogs.length}</LogBadge>}
            </LogButton>
          </ActionLeft>

          <SubmitButton disabled={!canSubmit} onClick={() => setIsSubmitDialogOpen(true)}>
            <FontAwesomeIcon icon={faPaperPlane} />
            Submit
          </SubmitButton>
        </ActionBar>
      </Main>

      <LogOverlay
        open={isLogOverlayOpen}
        onOpenChange={setIsLogOverlayOpen}
        entries={executionLogs}
        onClear={handleClearLogs}
      />

      <CrawlerSubmissionDialog
        open={isSubmitDialogOpen}
        onOpenChange={setIsSubmitDialogOpen}
        url={url}
        code={effectiveCode}
      />
    </PageContainer>
  );
}
