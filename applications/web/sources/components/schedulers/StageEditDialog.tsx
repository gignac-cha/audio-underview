import { useMemo, useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import * as Dialog from '@radix-ui/react-dialog';
import type { CrawlerRow, SchedulerStageRow } from '@audio-underview/supabase-connector';
import { useToast } from '../../hooks/use-toast.ts';
import { useUpdateStage, type UpdateStageInput } from '../../hooks/use-scheduler-manager.ts';
import { useListCrawlers } from '../../hooks/use-crawler-manager.ts';
import { groupTaskGroupVersions, useListTaskGroups, type TaskGroup } from '../../hooks/use-task-groups.ts';
import { CrawlerStageFields, crawlerStageValueFromStage, readInputSchema, type CrawlerStageValue } from './CrawlerStageFields.tsx';
import {
  FormStageFields,
  formStageValueFromStage,
  normalizeFormStageSettings,
  readFormStageSettings,
  type FormStageValue,
} from './FormStageFields.tsx';
import { TaskGroupSettingsFields } from './TaskGroupSettingsFields.tsx';
import {
  buildSettingsFields,
  changeSettingsFormat,
  createSettingsEditorState,
  readSettingsEditorState,
  type SettingsEditorState,
  type SettingsField,
} from './task-group-settings.ts';

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
`;

const Content = styled(Dialog.Content)`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 101;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.5rem;
  width: 90vw;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: var(--shadow-md);
`;

const Title = styled(Dialog.Title)`
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 1rem 0;
`;

const Description = styled(Dialog.Description)`
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0 0 1.25rem 0;
  line-height: 1.5;
`;

const FieldGroup = styled.div`
  margin-bottom: 1rem;
`;

const FieldLabel = styled.label`
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
`;

const Select = styled.select`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: var(--transition-fast);

  &:focus {
    border-color: var(--border-focus);
  }

  option {
    background: var(--bg-deep);
    color: var(--text-primary);
  }
`;

const StatusMessage = styled.p`
  font-size: 0.875rem;
  color: var(--text-muted);
  margin: 0;
`;

const ButtonRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
`;

const CancelButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const Spinner = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: ${spin} 0.6s linear infinite;
`;

const SubmitButton = styled('button', {
  shouldForwardProp: (prop) => prop !== 'isSubmitting',
})<{ isSubmitting?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: ${({ isSubmitting }) => (isSubmitting ? 'not-allowed' : 'pointer')};
  opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 1)};
  transition: var(--transition-fast);

  &:hover {
    opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 0.9)};
  }
`;

type StageChanges = Omit<UpdateStageInput, 'scheduler_id' | 'stage_id'>;

type StageChangesResult =
  | { ok: true; changes: StageChanges }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// JSON values compared without regard to the order of keys, which the database does not keep
function isSameJSONValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => isSameJSONValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => Object.hasOwn(right, key) && isSameJSONValue(left[key], right[key]));
  }
  return false;
}

function hasChanges(changes: StageChanges): boolean {
  return Object.keys(changes).length > 0;
}

interface SaveButtonsProperties {
  isSubmitting: boolean;
  canSave: boolean;
}

function SaveButtons({ isSubmitting, canSave }: SaveButtonsProperties) {
  return (
    <ButtonRow>
      <Dialog.Close asChild>
        <CancelButton type="button" disabled={isSubmitting}>Cancel</CancelButton>
      </Dialog.Close>
      <SubmitButton type="submit" disabled={isSubmitting || !canSave} isSubmitting={isSubmitting}>
        {isSubmitting && <Spinner />}
        {isSubmitting ? 'Saving...' : 'Save'}
      </SubmitButton>
    </ButtonRow>
  );
}

function readCrawlerStageChanges(
  stage: SchedulerStageRow,
  value: CrawlerStageValue,
  crawler: CrawlerRow | undefined,
): StageChangesResult {
  if (!value.crawlerID) {
    return { ok: false, error: 'Please select a crawler.' };
  }
  const inputSchema = readInputSchema(value, crawler);
  if (!inputSchema.ok) {
    return inputSchema;
  }

  const changes: StageChanges = {};
  if (value.crawlerID !== stage.crawler_id) {
    changes.crawler_id = value.crawlerID;
  }
  if (!isSameJSONValue(inputSchema.inputSchema, stage.input_schema)) {
    changes.input_schema = inputSchema.inputSchema;
  }
  const fanOutField = value.fanOutField.trim();
  if (fanOutField !== (stage.fan_out_field ?? '')) {
    changes.fan_out_field = fanOutField === '' ? null : fanOutField;
  }
  // The strategy shows only while there is a fan-out field
  if (fanOutField !== '' && value.fanOutStrategy !== undefined && value.fanOutStrategy !== stage.fan_out_strategy) {
    changes.fan_out_strategy = value.fanOutStrategy;
  }
  return { ok: true, changes };
}

interface CrawlerStageFormProperties {
  stage: SchedulerStageRow;
  crawlerMap: Map<string, CrawlerRow>;
  isSubmitting: boolean;
  onSave: (changes: StageChanges) => void;
}

function CrawlerStageForm({ stage, crawlerMap, isSubmitting, onSave }: CrawlerStageFormProperties) {
  const { showToast } = useToast();
  const { crawlers } = useListCrawlers();
  const [value, setValue] = useState<CrawlerStageValue>(
    () => crawlerStageValueFromStage(stage, stage.crawler_id === null ? undefined : crawlerMap.get(stage.crawler_id)),
  );

  const handleSubmit = () => {
    const crawler = crawlers.find((candidate) => candidate.id === value.crawlerID) ?? crawlerMap.get(value.crawlerID);
    const result = readCrawlerStageChanges(stage, value, crawler);
    if (!result.ok) {
      showToast('Validation Error', result.error, 'error');
      return;
    }
    onSave(result.changes);
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
      <CrawlerStageFields value={value} onChange={setValue} disabled={isSubmitting} />
      <SaveButtons isSubmitting={isSubmitting} canSave={value.crawlerID !== ''} />
    </form>
  );
}

interface FormStageFormProperties {
  stage: SchedulerStageRow;
  isSubmitting: boolean;
  onSave: (changes: StageChanges) => void;
}

function FormStageForm({ stage, isSubmitting, onSave }: FormStageFormProperties) {
  const { showToast } = useToast();
  const [value, setValue] = useState<FormStageValue>(() => formStageValueFromStage(stage));

  const handleSubmit = () => {
    const result = readFormStageSettings(value);
    if (!result.ok) {
      showToast('Validation Error', result.error, 'error');
      return;
    }

    // A stage that stores no timeout runs with the default, so the default typed back is no change
    const isUnchanged = isSameJSONValue(
      normalizeFormStageSettings(result.settings),
      normalizeFormStageSettings(stage.settings ?? {}),
    );
    onSave(isUnchanged ? {} : { settings: result.settings });
  };

  return (
    <form noValidate onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
      <FormStageFields value={value} onChange={setValue} disabled={isSubmitting} />
      <SaveButtons isSubmitting={isSubmitting} canSave />
    </form>
  );
}

function fieldsOfVersion(versions: TaskGroup[], version: number): SettingsField[] | undefined {
  const taskGroup = versions.find((candidate) => candidate.version === version);
  // A version that is not listed has no known format, so its settings are written as JSON
  return taskGroup ? buildSettingsFields(taskGroup.settings_schema) : undefined;
}

interface TaskGroupStageFormProperties {
  stage: SchedulerStageRow;
  // The registered versions of the stage's task group
  versions: TaskGroup[];
  isSubmitting: boolean;
  onSave: (changes: StageChanges) => void;
}

function TaskGroupStageForm({ stage, versions, isSubmitting, onSave }: TaskGroupStageFormProperties) {
  const { showToast } = useToast();
  // scheduler_stages_type_check guarantees a version on a task group stage
  const currentVersion = stage.task_group_version ?? 1;
  const storedSettings = stage.settings ?? {};

  const [version, setVersion] = useState(currentVersion);
  const [settingsState, setSettingsState] = useState<SettingsEditorState>(
    () => createSettingsEditorState(fieldsOfVersion(versions, currentVersion), storedSettings),
  );
  // What the fields showed when the dialog opened, such as a checkbox the stored settings leave out
  const [openedSettings] = useState(() => readSettingsEditorState(fieldsOfVersion(versions, currentVersion), settingsState));

  const versionOptions = useMemo(() => {
    const listedVersions = versions.map((taskGroup) => taskGroup.version);
    return listedVersions.includes(currentVersion) ? listedVersions : [...listedVersions, currentVersion].sort((left, right) => left - right);
  }, [versions, currentVersion]);
  const settingsFields = useMemo(() => fieldsOfVersion(versions, version), [versions, version]);

  const handleVersionChange = (nextVersion: number) => {
    setSettingsState(changeSettingsFormat(settingsFields, settingsState, fieldsOfVersion(versions, nextVersion)));
    setVersion(nextVersion);
  };

  const handleSubmit = () => {
    const settings = readSettingsEditorState(settingsFields, settingsState);
    if (!settings.ok) {
      showToast('Validation Error', settings.error, 'error');
      return;
    }

    const changes: StageChanges = {};
    if (version !== currentVersion) {
      // The server checks the settings against the new version's format, keys it does not list included
      changes.task_group_version = version;
      changes.settings = settings.settings;
    } else {
      const isUnchanged = isSameJSONValue(settings.settings, storedSettings)
        || (openedSettings.ok && isSameJSONValue(settings.settings, openedSettings.settings));
      if (!isUnchanged) {
        changes.settings = settings.settings;
      }
    }
    onSave(changes);
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
      <FieldGroup>
        <FieldLabel htmlFor="stage-task-group-version">Version</FieldLabel>
        <Select
          id="stage-task-group-version"
          value={String(version)}
          onChange={(event) => handleVersionChange(Number(event.target.value))}
          disabled={isSubmitting}
        >
          {versionOptions.map((optionVersion) => (
            <option key={optionVersion} value={String(optionVersion)}>v{optionVersion}</option>
          ))}
        </Select>
      </FieldGroup>

      <TaskGroupSettingsFields
        fields={settingsFields}
        state={settingsState}
        onChange={setSettingsState}
        disabled={isSubmitting}
      />

      <SaveButtons isSubmitting={isSubmitting} canSave />
    </form>
  );
}

interface StageEditDialogProperties {
  schedulerID: string;
  stage: SchedulerStageRow;
  crawlerMap: Map<string, CrawlerRow>;
  onOpenChange: (open: boolean) => void;
}

/**
 * Changes a stage without changing its type or its task group. Only the fields that changed are
 * sent; when nothing changed the dialog closes without a request.
 */
export function StageEditDialog({ schedulerID, stage, crawlerMap, onOpenChange }: StageEditDialogProperties) {
  const { showToast } = useToast();
  const { updateStage, status } = useUpdateStage();
  const { taskGroups, isLoaded: taskGroupsLoaded, isLoading: taskGroupsLoading, error: taskGroupsError } = useListTaskGroups();

  const isSubmitting = status === 'pending';
  const isTaskGroupStage = stage.stage_type === 'task_group';
  const isFormStage = stage.stage_type === 'form';
  // The form of a task group stage starts from the registered formats, so it waits for them
  const isWaitingForTaskGroups = isTaskGroupStage && !taskGroupsLoaded && (taskGroupsLoading || taskGroupsError !== undefined);

  const versions = useMemo(
    () => groupTaskGroupVersions(taskGroups).get(stage.task_group_id ?? '') ?? [],
    [taskGroups, stage.task_group_id],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isSubmitting) return;
    onOpenChange(nextOpen);
  };

  const handleSave = async (changes: StageChanges) => {
    if (!hasChanges(changes)) {
      onOpenChange(false);
      return;
    }
    try {
      await updateStage({ scheduler_id: schedulerID, stage_id: stage.id, ...changes });
      showToast('Success', 'Stage updated.', 'success');
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update stage';
      showToast('Error', message, 'error');
    }
  };

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <Title>Edit Stage</Title>
          <Description>
            {isTaskGroupStage
              ? `Change the version and settings of task group ${stage.task_group_id}.`
              : isFormStage
                ? 'Change the form definition and the timeout of this stage.'
                : 'Change the crawler, input schema and fan-out of this stage.'}
          </Description>

          {isFormStage ? (
            <FormStageForm stage={stage} isSubmitting={isSubmitting} onSave={handleSave} />
          ) : !isTaskGroupStage ? (
            <CrawlerStageForm stage={stage} crawlerMap={crawlerMap} isSubmitting={isSubmitting} onSave={handleSave} />
          ) : isWaitingForTaskGroups ? (
            <>
              <StatusMessage>
                {taskGroupsError ? `Failed to load task groups: ${taskGroupsError.message}` : 'Loading task groups...'}
              </StatusMessage>
              <ButtonRow>
                <Dialog.Close asChild>
                  <CancelButton type="button">Cancel</CancelButton>
                </Dialog.Close>
              </ButtonRow>
            </>
          ) : (
            <TaskGroupStageForm stage={stage} versions={versions} isSubmitting={isSubmitting} onSave={handleSave} />
          )}
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
