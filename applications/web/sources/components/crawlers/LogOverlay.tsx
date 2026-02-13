import styled from '@emotion/styled';
import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { StatusLogPanel } from './StatusLogPanel.tsx';
import type { LogEntry } from '../../hooks/use-crawler-code-runner.ts';

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
  width: 90vw;
  max-width: 800px;
  height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-md);
  overflow: hidden;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
`;

const Title = styled(Dialog.Title)`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

const HeaderActions = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const ClearButton = styled.button`
  font-size: 0.8125rem;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-secondary);
    background: var(--bg-deep);
  }
`;

const CloseButton = styled(Dialog.Close)`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const Body = styled.div`
  flex: 1;
  min-height: 0;
  padding: 1rem 1.25rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`;

interface LogOverlayProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: LogEntry[];
  onClear: () => void;
}

export function LogOverlay({ open, onOpenChange, entries, onClear }: LogOverlayProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <Header>
            <Title>Status Log</Title>
            <HeaderActions>
              {entries.length > 0 && (
                <ClearButton onClick={onClear}>Clear</ClearButton>
              )}
              <CloseButton>
                <FontAwesomeIcon icon={faXmark} />
              </CloseButton>
            </HeaderActions>
          </Header>
          <Body>
            <StatusLogPanel entries={entries} />
          </Body>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
