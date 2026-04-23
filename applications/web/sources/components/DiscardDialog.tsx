import styled from '@emotion/styled';
import * as Dialog from '@radix-ui/react-dialog';

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
  max-width: 420px;
  box-shadow: var(--shadow-md);
`;

const Title = styled(Dialog.Title)`
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 0.5rem 0;
`;

const Description = styled(Dialog.Description)`
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0 0 1.25rem 0;
  line-height: 1.5;
`;

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
`;

const KeepButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  cursor: pointer;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const DiscardButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--color-error, #b91c1c);
  cursor: pointer;

  &:hover {
    opacity: 0.9;
  }
`;

interface DiscardDialogProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  keepLabel?: string;
}

export function DiscardDialog({
  open,
  onOpenChange,
  onConfirm,
  title = 'Discard unsaved changes?',
  description = 'You have unsaved changes. If you leave now, they will be lost.',
  confirmLabel = 'Discard',
  keepLabel = 'Keep editing',
}: DiscardDialogProperties) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content role="alertdialog">
          <Title>{title}</Title>
          <Description>{description}</Description>
          <Actions>
            <KeepButton type="button" onClick={() => onOpenChange(false)} autoFocus>
              {keepLabel}
            </KeepButton>
            <DiscardButton type="button" onClick={onConfirm}>
              {confirmLabel}
            </DiscardButton>
          </Actions>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
