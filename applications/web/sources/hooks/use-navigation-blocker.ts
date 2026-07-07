import { useBlocker, type BlockerFunction } from 'react-router';

export interface NavigationBlock {
  isBlocked: boolean;
  confirm: () => void;
  cancel: () => void;
}

/**
 * SPA 내부 라우팅 dirty guard (개선 §5). `shouldBlock`이 true(또는 true 반환)면 라우팅을
 * 가로채고, 소비자는 `isBlocked`일 때 확인 dialog를 띄운 뒤 confirm/cancel로 진행/취소한다.
 * (data router 필요 — main.tsx의 createBrowserRouter.)
 */
export const useNavigationBlocker = (shouldBlock: boolean | BlockerFunction): NavigationBlock => {
  const blocker = useBlocker(shouldBlock);
  return {
    isBlocked: blocker.state === 'blocked',
    confirm: () => {
      if (blocker.state === 'blocked') {
        blocker.proceed();
      }
    },
    cancel: () => {
      if (blocker.state === 'blocked') {
        blocker.reset();
      }
    },
  };
};
