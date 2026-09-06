import { useCallback, useState } from 'react';

export type EditorMode = 'create' | 'view' | 'edit';

/** create/view/edit 3모드 상태 머신 (스펙 §4.3.1). */
export const useEditorMode = (isCreate: boolean) => {
  const [mode, setMode] = useState<EditorMode>(isCreate ? 'create' : 'view');

  const enterEdit = useCallback(() => {
    setMode('edit');
  }, []);

  const exitToView = useCallback(() => {
    setMode('view');
  }, []);

  return {
    mode,
    isEditable: mode === 'create' || mode === 'edit',
    enterEdit,
    exitToView,
  };
};
