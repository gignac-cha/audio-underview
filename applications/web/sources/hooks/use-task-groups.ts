import { useQuery } from '@tanstack/react-query';
import type { TaskGroupRow } from '@audio-underview/supabase-connector';
import { hasAccessToken, requestSchedulerManagerJSON } from './scheduler-manager-request.ts';

/**
 * One registered task group version as the scheduler manager lists it, without the binding of
 * the group's worker. Omit would lose every named field to the row's index signature, so the
 * fields are picked.
 */
export type TaskGroup = Pick<TaskGroupRow, 'id' | 'version' | 'input_schema' | 'settings_schema' | 'output_schema' | 'created_at'>;

export const TASK_GROUPS_QUERY_KEY = ['task-groups'] as const;

/**
 * The versions of each task group, lowest first, in the order the groups are listed.
 */
export function groupTaskGroupVersions(taskGroups: TaskGroup[]): Map<string, TaskGroup[]> {
  const versions = new Map<string, TaskGroup[]>();
  for (const taskGroup of taskGroups) {
    const groupVersions = versions.get(taskGroup.id) ?? [];
    groupVersions.push(taskGroup);
    versions.set(taskGroup.id, groupVersions);
  }
  for (const groupVersions of versions.values()) {
    groupVersions.sort((left, right) => left.version - right.version);
  }
  return versions;
}

/**
 * The highest registered version of each task group.
 */
export function findLatestTaskGroupVersions(taskGroups: TaskGroup[]): Map<string, number> {
  const latestVersions = new Map<string, number>();
  for (const taskGroup of taskGroups) {
    const latestVersion = latestVersions.get(taskGroup.id);
    if (latestVersion === undefined || taskGroup.version > latestVersion) {
      latestVersions.set(taskGroup.id, taskGroup.version);
    }
  }
  return latestVersions;
}

export function useListTaskGroups() {
  const query = useQuery<TaskGroup[], Error>({
    queryKey: TASK_GROUPS_QUERY_KEY,
    queryFn: async () => {
      const body = await requestSchedulerManagerJSON('/task-groups') as { data: TaskGroup[] };
      return body.data;
    },
    enabled: hasAccessToken(),
  });

  return {
    taskGroups: query.data ?? [],
    isLoading: query.isLoading,
    // Stays true when a later refetch fails, since the list is still there
    isLoaded: query.data !== undefined,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
}
