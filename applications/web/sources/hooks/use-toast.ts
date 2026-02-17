import { useContext } from 'react';
import { ToastContext, type ToastContextValue } from '../contexts/toast-context-value.ts';

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return context;
}
