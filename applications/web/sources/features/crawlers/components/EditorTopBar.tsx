import { Badge, type BadgeTone } from '../../../components/Badge.tsx';
import { Button } from '../../../components/Button.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { shortcutLabel } from '../../../hooks/use-platform.ts';
import type { EditorMode } from '../hooks/use-editor-mode.ts';
import styles from './EditorTopBar.module.css';

const MODE_LABEL: Record<EditorMode, string> = { create: 'Create', edit: 'Edit', view: 'View' };
const MODE_TONE: Record<EditorMode, BadgeTone> = {
  create: 'accent',
  edit: 'accent',
  view: 'neutral',
};

export interface EditorTopBarProps {
  mode: EditorMode;
  title: string;
  isDirty: boolean;
  showTestPanel: boolean;
  canSubmit: boolean;
  disabledReason?: string;
  isSaving: boolean;
  onBack: () => void;
  onToggleTest: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}

export const EditorTopBar = ({
  mode,
  title,
  isDirty,
  showTestPanel,
  canSubmit,
  disabledReason,
  isSaving,
  onBack,
  onToggleTest,
  onEdit,
  onCancel,
  onSave,
}: EditorTopBarProps) => {
  const saveButton = (label: string) => (
    <Button
      variant="primary"
      shortcutHint={shortcutLabel('S')}
      disabled={isSaving}
      disabledReason={canSubmit || isSaving ? undefined : disabledReason}
      onClick={onSave}
    >
      {isSaving ? 'Saving…' : label}
    </Button>
  );

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <Button
          variant="ghost"
          size="small"
          iconLeft={<Icon name="arrowLeft" size={16} />}
          onClick={onBack}
        >
          Back
        </Button>
        <div className={styles.titleGroup}>
          <h1 className={styles.title}>{title}</h1>
          <Badge tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Badge>
          <span className={styles.unsaved} aria-live="polite">
            {isDirty && (
              <Badge tone="warning" dot>
                Unsaved
              </Badge>
            )}
          </span>
        </div>
      </div>

      <div className={styles.right}>
        {mode === 'view' && (
          <>
            <Button variant="secondary" size="medium" onClick={onToggleTest}>
              {showTestPanel ? 'Hide Test' : 'Show Test'}
            </Button>
            <Button
              variant="primary"
              iconLeft={<Icon name="edit" size={15} />}
              shortcutHint={shortcutLabel('E')}
              onClick={onEdit}
            >
              Edit
            </Button>
          </>
        )}
        {mode === 'create' && saveButton('Submit')}
        {mode === 'edit' && (
          <>
            <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
              Cancel
            </Button>
            {saveButton('Save')}
          </>
        )}
      </div>
    </div>
  );
};
