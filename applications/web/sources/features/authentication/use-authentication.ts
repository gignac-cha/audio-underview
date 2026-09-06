import { useQueryClient } from '@tanstack/react-query';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import {
  authenticatedUserAtom,
  isAuthenticatedAtom,
  sessionAtom,
} from '../../state/session.ts';

/**
 * 인증 상태 단일 소스 소비 훅 (세션 atom 기반). 만료 반응성은 atom 갱신으로 자연히 흐른다.
 */
export const useAuthentication = () => {
  const user = useAtomValue(authenticatedUserAtom);
  const isAuthenticated = useAtomValue(isAuthenticatedAtom);
  const setSession = useSetAtom(sessionAtom);
  const queryClient = useQueryClient();

  const signOut = useCallback(() => {
    setSession(null);
    queryClient.clear();
  }, [setSession, queryClient]);

  return { user, isAuthenticated, signOut };
};
