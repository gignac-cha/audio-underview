import { useEffect } from 'react';

export function useBeforeUnload(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy fallback for Chrome <119; ignored by modern browsers.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled]);
}
