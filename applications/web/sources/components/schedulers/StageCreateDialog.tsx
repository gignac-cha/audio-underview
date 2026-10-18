import { useState, useMemo } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import * as Dialog from '@radix-ui/react-dialog';
import type { SchedulerStageType } from '@audio-underview/supabase-connector';
import { useToast } from '../../hooks/use-toast.ts';
import { useCreateStage, type CreateStageInput } from '../../hooks/use-scheduler-manager.ts';
import { useListCrawlers } from '../../hooks/use-crawler-manager.ts';
import { groupTaskGroupVersions, useListTaskGroups } from '../../hooks/use-task-groups.ts';
import { CrawlerStageFields, EMPTY_CRAWLER_STAGE_VALUE, readInputSchema, type CrawlerStageValue } from './CrawlerStageFields.tsx';
import { TaskGroupSettingsFields } from './TaskGroupSettingsFields.tsx';
import {
  buildSettingsFields,
  changeSettingsFormat,
  createSettingsEditorState,
  defaultSettings,
  readSettingsEditorState,
  type SettingsEditorState,
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

const FieldHint = styled.p`
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 0.375rem 0 0 0;
`;

const ErrorHint = styled(FieldHint)`
  color: var(--color-error);
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

interface StageCreateDialogProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedulerID: string;
  nextOrder: number;
}

const EMPTY_SETTINGS_EDITOR_STATE: SettingsEditorState = createSettingsEditorState(undefined, {});

export function StageCreateDialog({ open, onOpenChange, schedulerID, nextOrder }: StageCreateDialogProperties) {
  const { showToast } = useToast();
  const { createStage, status } = useCreateStage();
  const { crawlers } = useListCrawlers();
  const { taskGroups, isLoaded: taskGroupsLoaded, error: taskGroupsError } = useListTaskGroups();

  const [stageType, setStageType] = useState<SchedulerStageType>('crawler');
  const [crawlerValue, setCrawlerValue] = useState<CrawlerStageValue>(EMPTY_CRAWLER_STAGE_VALUE);
  const [taskGroupID, setTaskGroupID] = useState('');
  const [taskGroupVersion, setTaskGroupVersion] = useState<number | undefined>(undefined);
  const [settingsState, setSettingsState] = useState<SettingsEditorState>(EMPTY_SETTINGS_EDITOR_STATE);

  const isSubmitting = status === 'pending';

  const versionsByTaskGroup = useMemo(() => groupTaskGroupVersions(taskGroups), [taskGroups]);
  const taskGroupVersions = versionsByTaskGroup.get(taskGroupID) ?? [];
  const selectedTaskGroup = taskGroupVersions.find((taskGroup) => taskGroup.version === taskGroupVersion);
  const settingsFields = useMemo(
    () => (selectedTaskGroup ? buildSettingsFields(selectedTaskGroup.settings_schema) : undefined),
    [selectedTaskGroup],
  );

  const handleTaskGroupChange = (nextTaskGroupID: string) => {
    // A new stage starts at the latest version with its defaults
    const latestTaskGroup = versionsByTaskGroup.get(nextTaskGroupID)?.at(-1);
    const fields = latestTaskGroup ? buildSettingsFields(latestTaskGroup.settings_schema) : undefined;
    setTaskGroupID(nextTaskGroupID);
    setTaskGroupVersion(latestTaskGroup?.version);
    setSettingsState(createSettingsEditorState(fields, fields ? defaultSettings(fields) : {}));
  };

  const handleTaskGroupVersionChange = (nextVersion: number) => {
    const nextTaskGroup = taskGroupVersions.find((taskGroup) => taskGroup.version === nextVersion);
    const nextFields = nextTaskGroup ? buildSettingsFields(nextTaskGroup.settings_schema) : undefined;
    setTaskGroupVersion(nextVersion);
    setSettingsState(changeSettingsFormat(settingsFields, settingsState, nextFields));
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isSubmitting) return;
    if (!nextOpen) {
      setStageType('crawler');
      setCrawlerValue(EMPTY_CRAWLER_STAGE_VALUE);
      setTaskGroupID('');
      setTaskGroupVersion(undefined);
      setSettingsState(EMPTY_SETTINGS_EDITOR_STATE);
    }
    onOpenChange(nextOpen);
  };

  const buildCrawlerStageInput = (): CreateStageInput | undefined => {
    if (!crawlerValue.crawlerID) {
      showToast('Validation Error', 'Please select a crawler.', 'error');
      return undefined;
    }

    const selectedCrawler = crawlers.find((crawler) => crawler.id === crawlerValue.crawlerID);
    const inputSchema = readInputSchema(crawlerValue, selectedCrawler);
    if (!inputSchema.ok) {
      showToast('Validation Error', inputSchema.error, 'error');
      return undefined;
    }

    const fanOutField = crawlerValue.fanOutField.trim();
    return {
      scheduler_id: schedulerID,
      crawler_id: crawlerValue.crawlerID,
      stage_order: nextOrder,
      input_schema: inputSchema.inputSchema,
      fan_out_field: fanOutField.length > 0 ? fanOutField : undefined,
      fan_out_strategy: fanOutField.length > 0 ? crawlerValue.fanOutStrategy : undefined,
    };
  };

  const buildTaskGroupStageInput = (): CreateStageInput | undefined => {
    if (!taskGroupID || taskGroupVersion === undefined) {
      showToast('Validation Error', 'Please select a task group.', 'error');
      return undefined;
    }

    const settings = readSettingsEditorState(settingsFields, settingsState);
    if (!settings.ok) {
      showToast('Validation Error', settings.error, 'error');
      return undefined;
    }

    return {
      scheduler_id: schedulerID,
      stage_type: 'task_group',
      task_group_id: taskGroupID,
      task_group_version: taskGroupVersion,
      settings: settings.settings,
      stage_order: nextOrder,
    };
  };

  const handleSubmit = async () => {
    const input = stageType === 'task_group' ? buildTaskGroupStageInput() : buildCrawlerStageInput();
    if (!input) return;

    try {
      await createStage(input);
      showToast('Success', 'Stage added to pipeline.', 'success');
      handleOpenChange(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create stage';
      showToast('Error', message, 'error');
    }
  };

  const hasTaskGroups = taskGroups.length > 0;
  const canSubmit = stageType === 'task_group' ? taskGroupID !== '' : crawlerValue.crawlerID !== '';

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <Title>Add Stage</Title>
          <Description>Add a crawler or a task group as a new stage in this pipeline.</Description>

          <FieldGroup>
            <FieldLabel htmlFor="stage-type">Stage Type</FieldLabel>
            <Select
              id="stage-type"
              value={stageType}
              onChange={(event) => setStageType(event.target.value as SchedulerStageType)}
              disabled={isSubmitting}
            >
              <option value="crawler">Crawler</option>
              <option value="task_group" disabled={!hasTaskGroups}>Task group</option>
            </Select>
            {taskGroupsError ? (
              <ErrorHint>{`Failed to load task groups: ${taskGroupsError.message}`}</ErrorHint>
            ) : taskGroupsLoaded && !hasTaskGroups ? (
              <FieldHint>No task groups are available yet.</FieldHint>
            ) : null}
          </FieldGroup>

          {stageType === 'task_group' ? (
            <>
              <FieldGroup>
                <FieldLabel htmlFor="stage-task-group">Task Group</FieldLabel>
                <Select
                  id="stage-task-group"
                  value={taskGroupID}
                  onChange={(event) => handleTaskGroupChange(event.target.value)}
                  disabled={isSubmitting}
                >
                  <option value="">Select a task group...</option>
                  {[...versionsByTaskGroup.keys()].map((groupID) => (
                    <option key={groupID} value={groupID}>{groupID}</option>
                  ))}
                </Select>
              </FieldGroup>

              {taskGroupVersion !== undefined && (
                <>
                  <FieldGroup>
                    <FieldLabel htmlFor="stage-task-group-version">Version</FieldLabel>
                    <Select
                      id="stage-task-group-version"
                      value={String(taskGroupVersion)}
                      onChange={(event) => handleTaskGroupVersionChange(Number(event.target.value))}
                      disabled={isSubmitting}
                    >
                      {taskGroupVersions.map((taskGroup) => (
                        <option key={taskGroup.version} value={String(taskGroup.version)}>v{taskGroup.version}</option>
                      ))}
                    </Select>
                  </FieldGroup>

                  <TaskGroupSettingsFields
                    fields={settingsFields}
                    state={settingsState}
                    onChange={setSettingsState}
                    disabled={isSubmitting}
                  />
                </>
              )}
            </>
          ) : (
            <CrawlerStageFields value={crawlerValue} onChange={setCrawlerValue} disabled={isSubmitting} />
          )}

          <ButtonRow>
            <Dialog.Close asChild>
              <CancelButton disabled={isSubmitting}>Cancel</CancelButton>
            </Dialog.Close>
            <SubmitButton onClick={handleSubmit} disabled={isSubmitting || !canSubmit} isSubmitting={isSubmitting}>
              {isSubmitting && <Spinner />}
              {isSubmitting ? 'Adding...' : 'Add Stage'}
            </SubmitButton>
          </ButtonRow>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
