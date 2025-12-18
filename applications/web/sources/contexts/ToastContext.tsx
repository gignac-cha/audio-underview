import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import * as Toast from '@radix-ui/react-toast';

type ToastType = 'success' | 'error' | 'info';

interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (title: string, description?: string, type?: ToastType) => void;
  showError: (title: string, description?: string) => void;
  showSuccess: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

function generateToastID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

const hide = keyframes`
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
`;

const slideIn = keyframes`
  from {
    transform: translateX(calc(100% + 1.5rem));
  }
  to {
    transform: translateX(0);
  }
`;

const swipeOut = keyframes`
  from {
    transform: translateX(var(--radix-toast-swipe-end-x));
  }
  to {
    transform: translateX(calc(100% + 1.5rem));
  }
`;

const StyledViewport = styled(Toast.Viewport)`
  position: fixed;
  bottom: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
  gap: 0.75rem;
  width: 420px;
  max-width: 100vw;
  margin: 0;
  list-style: none;
  z-index: 9999;
  outline: none;
`;

const StyledRoot = styled(Toast.Root)<{ toastType: ToastType }>`
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  box-shadow: var(--shadow-md);
  padding: 1rem;
  display: grid;
  grid-template-areas:
    'title close'
    'description close';
  grid-template-columns: 1fr auto;
  column-gap: 1rem;
  align-items: start;

  &[data-state='open'] {
    animation: ${slideIn} 150ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  &[data-state='closed'] {
    animation: ${hide} 100ms ease-in;
  }

  &[data-swipe='move'] {
    transform: translateX(var(--radix-toast-swipe-move-x));
  }

  &[data-swipe='cancel'] {
    transform: translateX(0);
    transition: transform 200ms ease-out;
  }

  &[data-swipe='end'] {
    animation: ${swipeOut} 100ms ease-out;
  }

  border-left: 3px solid
    ${({ toastType }) =>
      toastType === 'error'
        ? 'var(--color-error)'
        : toastType === 'success'
          ? 'var(--color-success)'
          : 'var(--accent-primary)'};
`;

const StyledTitle = styled(Toast.Title)`
  grid-area: title;
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.875rem;
`;

const StyledDescription = styled(Toast.Description)`
  grid-area: description;
  margin-top: 0.25rem;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  line-height: 1.4;
`;

const StyledClose = styled(Toast.Close)`
  grid-area: close;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 1.25rem;
  line-height: 1;
  padding: 0;
  transition: color 0.2s;

  &:hover {
    color: var(--text-primary);
  }
`;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((title: string, description?: string, type: ToastType = 'info') => {
    const id = generateToastID();
    setToasts((previous) => [...previous, { id, title, description, type }]);
  }, []);

  const showError = useCallback(
    (title: string, description?: string) => {
      showToast(title, description, 'error');
    },
    [showToast]
  );

  const showSuccess = useCallback(
    (title: string, description?: string) => {
      showToast(title, description, 'success');
    },
    [showToast]
  );

  const removeToast = useCallback((id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, showError, showSuccess }}>
      <Toast.Provider swipeDirection="right">
        {children}
        {toasts.map((toast) => (
          <StyledRoot
            key={toast.id}
            toastType={toast.type}
            onOpenChange={(open) => {
              if (!open) removeToast(toast.id);
            }}
          >
            <StyledTitle>{toast.title}</StyledTitle>
            {toast.description && <StyledDescription>{toast.description}</StyledDescription>}
            <StyledClose aria-label="Close">×</StyledClose>
          </StyledRoot>
        ))}
        <StyledViewport />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
