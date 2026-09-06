import {
  createDatabaseClient,
  createScheduler,
  createSchedulerRun,
  createSchedulerStage,
  createSchedulerStageRun,
  deleteScheduler,
  deleteSchedulerStage,
  getCrawlerPermission,
  getScheduler,
  getSchedulerRun,
  getSchedulerStage,
  listEnabledSchedulersWithCron,
  listSchedulerRuns,
  listSchedulerStages,
  listSchedulersByUser,
  reorderSchedulerStages,
  updateScheduler,
  updateSchedulerRun,
  updateSchedulerStage,
  updateSchedulerStageRun,
  type CrawlerPermissionRow,
  type ListOptions,
  type ListResult,
  type SchedulerRow,
  type SchedulerRunRow,
  type SchedulerRunsInsert,
  type SchedulerRunsUpdate,
  type SchedulersInsert,
  type SchedulersUpdate,
  type SchedulerStageRow,
  type SchedulerStageRunRow,
  type SchedulerStageRunsInsert,
  type SchedulerStageRunsUpdate,
  type SchedulerStagesInsert,
  type SchedulerStagesUpdate,
  type UpdateSchedulerRunOptions,
} from '@audio-underview/database-connector';
import { createServiceBindingCrawlerExecutionClient, type CrawlerExecutionClient } from './crawler-execution-client.ts';
import {
  parseSchedulerManagerEnvironment,
  type WorkerEnvironment,
} from './environment.ts';

export interface SchedulerManagerServices {
  schedulers: {
    create(input: SchedulersInsert): Promise<SchedulerRow>;
    list(userUUID: string, options: ListOptions): Promise<ListResult<SchedulerRow>>;
    get(id: string, userUUID: string): Promise<SchedulerRow | undefined>;
    update(id: string, userUUID: string, input: SchedulersUpdate): Promise<SchedulerRow | undefined>;
    delete(id: string, userUUID: string): Promise<boolean>;
    listEnabledWithCron(): Promise<SchedulerRow[]>;
  };
  stages: {
    create(input: SchedulerStagesInsert): Promise<SchedulerStageRow>;
    list(schedulerID: string): Promise<SchedulerStageRow[]>;
    get(id: string, schedulerID: string): Promise<SchedulerStageRow | undefined>;
    update(
      id: string,
      schedulerID: string,
      input: SchedulerStagesUpdate,
    ): Promise<SchedulerStageRow | undefined>;
    delete(id: string, schedulerID: string): Promise<boolean>;
    reorder(schedulerID: string, stageIDs: string[]): Promise<SchedulerStageRow[]>;
  };
  runs: {
    create(input: SchedulerRunsInsert): Promise<SchedulerRunRow>;
    get(id: string, schedulerID: string): Promise<SchedulerRunRow | undefined>;
    update(
      id: string,
      schedulerID: string,
      input: SchedulerRunsUpdate,
      options?: UpdateSchedulerRunOptions,
    ): Promise<SchedulerRunRow | undefined>;
    list(schedulerID: string, options: ListOptions): Promise<ListResult<SchedulerRunRow>>;
  };
  stageRuns: {
    create(input: SchedulerStageRunsInsert): Promise<SchedulerStageRunRow>;
    update(
      id: string,
      runID: string,
      input: SchedulerStageRunsUpdate,
    ): Promise<SchedulerStageRunRow | undefined>;
  };
  crawlerPermissions: {
    get(crawlerID: string, userUUID: string): Promise<CrawlerPermissionRow | undefined>;
  };
  crawlerExecution: CrawlerExecutionClient;
}

export type ResolveServices = (environment: WorkerEnvironment) => SchedulerManagerServices;

export const createServices: ResolveServices = (rawEnvironment) => {
  const environment = parseSchedulerManagerEnvironment(rawEnvironment);
  const client = createDatabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  return {
    schedulers: {
      create: (input) => createScheduler(client, input),
      list: (userUUID, options) => listSchedulersByUser(client, userUUID, options),
      get: (id, userUUID) => getScheduler(client, id, userUUID),
      update: (id, userUUID, input) => updateScheduler(client, id, userUUID, input),
      delete: (id, userUUID) => deleteScheduler(client, id, userUUID),
      listEnabledWithCron: () => listEnabledSchedulersWithCron(client),
    },
    stages: {
      create: (input) => createSchedulerStage(client, input),
      list: (schedulerID) => listSchedulerStages(client, schedulerID),
      get: (id, schedulerID) => getSchedulerStage(client, id, schedulerID),
      update: (id, schedulerID, input) => updateSchedulerStage(client, id, schedulerID, input),
      delete: (id, schedulerID) => deleteSchedulerStage(client, id, schedulerID),
      reorder: (schedulerID, stageIDs) => reorderSchedulerStages(client, schedulerID, stageIDs),
    },
    runs: {
      create: (input) => createSchedulerRun(client, input),
      get: (id, schedulerID) => getSchedulerRun(client, id, schedulerID),
      update: (id, schedulerID, input, options) =>
        updateSchedulerRun(client, id, schedulerID, input, options),
      list: (schedulerID, options) => listSchedulerRuns(client, schedulerID, options),
    },
    stageRuns: {
      create: (input) => createSchedulerStageRun(client, input),
      update: (id, runID, input) => updateSchedulerStageRun(client, id, runID, input),
    },
    crawlerPermissions: {
      get: (crawlerID, userUUID) => getCrawlerPermission(client, crawlerID, userUUID),
    },
    crawlerExecution: createServiceBindingCrawlerExecutionClient(environment.CRAWLER_MANAGER),
  };
};
