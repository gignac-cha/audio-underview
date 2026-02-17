import { createContext } from 'react';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastContextValue {
  showToast: (title: string, description?: string, type?: ToastType) => void;
  showError: (title: string, description?: string) => void;
  showSuccess: (title: string, description?: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);
