import { useEffect } from 'react';

/** enabled일 때 브라우저 새로고침/탭 닫기에 native beforeunload 경고 (스펙 §4.3.8). */
export const useBeforeUnload = (enabled: boolean): void => {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handler = (event: BeforeUnloadEvent) => {
      // preventDefault만으로 최신 브라우저의 이탈 확인 프롬프트가 트리거된다.
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [enabled]);
};
