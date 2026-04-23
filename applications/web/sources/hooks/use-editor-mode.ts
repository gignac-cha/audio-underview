import { useState } from 'react';

export type EditorMode = 'create' | 'view' | 'edit';

export function useEditorMode(isCreateMode: boolean) {
  const [isEditMode, setIsEditMode] = useState(false);

  const mode: EditorMode = isCreateMode ? 'create' : isEditMode ? 'edit' : 'view';
  const isEditable = mode === 'create' || mode === 'edit';

  const enterEdit = () => setIsEditMode(true);
  const exitEdit = () => setIsEditMode(false);

  return { mode, isEditable, isEditMode, enterEdit, exitEdit };
}
