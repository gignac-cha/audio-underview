import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import * as Toast from '@radix-ui/react-toast';
import './ToastContext.scss';

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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback((title: string, description?: string, type: ToastType = 'info') => {
    const id = generateToastID();
    setToasts((previous) => [...previous, { id, title, description, type }]);
  }, []);

  const showError = useCallback((title: string, description?: string) => {
    showToast(title, description, 'error');
  }, [showToast]);

  const showSuccess = useCallback((title: string, description?: string) => {
    showToast(title, description, 'success');
  }, [showToast]);

  const removeToast = useCallback((id: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast, showError, showSuccess }}>
      <Toast.Provider swipeDirection="right">
        {children}
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            className={`toast-root toast-${toast.type}`}
            onOpenChange={(open) => {
              if (!open) removeToast(toast.id);
            }}
          >
            <Toast.Title className="toast-title">{toast.title}</Toast.Title>
            {toast.description && (
              <Toast.Description className="toast-description">
                {toast.description}
              </Toast.Description>
            )}
            <Toast.Close className="toast-close" aria-label="Close">
              ×
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport className="toast-viewport" />
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
