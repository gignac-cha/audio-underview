import { atom, useSetAtom } from 'jotai';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastMessage {
  id: number;
  type: ToastType;
  title: string;
  description?: string;
}

export const toastsAtom = atom<ToastMessage[]>([]);

let toastSequence = 0;

export const pushToastAtom = atom(null, (get, set, toast: Omit<ToastMessage, 'id'>) => {
  toastSequence += 1;
  set(toastsAtom, [...get(toastsAtom), { ...toast, id: toastSequence }]);
});

export const dismissToastAtom = atom(null, (get, set, id: number) => {
  set(
    toastsAtom,
    get(toastsAtom).filter((toast) => toast.id !== id),
  );
});

/** 페이지/훅에서 쓰는 토스트 발행 API */
export const useToasts = () => {
  const push = useSetAtom(pushToastAtom);
  return {
    showSuccess: (title: string, description?: string) => {
      push({ type: 'success', title, description });
    },
    showError: (title: string, description?: string) => {
      push({ type: 'error', title, description });
    },
    showInfo: (title: string, description?: string) => {
      push({ type: 'info', title, description });
    },
  };
};
