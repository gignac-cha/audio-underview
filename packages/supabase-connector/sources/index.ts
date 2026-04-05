// Types
export type {
  ProviderType,
  CrawlerType,
  SchedulerRunStatus,
  UserRow,
  AccountRow,
  CrawlerRow,
  SchedulerRow,
  FanOutStrategy,
  SchedulerStageRow,
  SchedulerRunRow,
  SchedulerStageRunRow,
  UsersInsert,
  AccountsInsert,
  CrawlersInsert,
  CrawlersUpdate,
  SchedulersInsert,
  SchedulersUpdate,
  SchedulerStagesInsert,
  SchedulerStagesUpdate,
  SchedulerRunsInsert,
  SchedulerRunsUpdate,
  SchedulerStageRunsInsert,
  SchedulerStageRunsUpdate,
  SocialLoginInput,
  SocialLoginResult,
  LinkAccountResult,
  CrawlerPermissionLevel,
  CrawlerPermissionRow,
  SupabaseConnectorConfiguration,
  Database,
} from './types/index.ts';

// Client
export { createSupabaseClient } from './client.ts';
export type { SupabaseClient } from './client.ts';

// Account operations
export {
  findAccount,
  findUser,
  getAccountsByUser,
  createUser,
  createAccount,
  handleSocialLogin,
  linkAccount,
  unlinkAccount,
  deleteUser,
} from './accounts.ts';

// Crawler operations
export type { PaginatedCrawlers } from './crawlers.ts';
export {
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  getCrawlerByID,
  updateCrawler,
  deleteCrawler,
} from './crawlers.ts';

// Crawler permission operations
export {
  createCrawlerPermission,
  getCrawlerPermission,
  deleteCrawlerPermission,
} from './crawler-permissions.ts';

// Scheduler operations
export type { PaginatedSchedulers } from './schedulers.ts';
export {
  createScheduler,
  listSchedulersByUser,
  getScheduler,
  updateScheduler,
  deleteScheduler,
} from './schedulers.ts';

// Scheduler stage operations
export {
  createSchedulerStage,
  listSchedulerStages,
  getSchedulerStage,
  updateSchedulerStage,
  deleteSchedulerStage,
  reorderSchedulerStages,
} from './scheduler-stages.ts';

// Scheduler run operations
export type { PaginatedSchedulerRuns } from './scheduler-runs.ts';
export {
  createSchedulerRun,
  getSchedulerRun,
  updateSchedulerRun,
  listSchedulerRuns,
} from './scheduler-runs.ts';

// Scheduler stage run operations
export {
  createSchedulerStageRun,
  updateSchedulerStageRun,
  listSchedulerStageRunsByRun,
} from './scheduler-stage-runs.ts';
