// Types
export type {
  ProviderType,
  CrawlerType,
  SchedulerRunStatus,
  SchedulerRunTrigger,
  UserRow,
  AccountRow,
  CrawlerRow,
  SchedulerRow,
  FanOutStrategy,
  SchedulerStageType,
  SchedulerStageRow,
  TaskGroupRow,
  SchedulerRunRow,
  SchedulerStageRunProgress,
  SchedulerStageRunRow,
  SchedulerStageRunSummary,
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

// Session tokens (self-issued account JWTs)
export type {
  SessionTokenClaims,
  SessionTokenPayload,
  SessionTokenVerifier,
  CreateSessionTokenPayloadOptions,
} from './session-tokens.ts';
export {
  SESSION_TOKEN_LIFETIME_SECONDS,
  createSessionTokenPayload,
  readBearerToken,
  toSessionTokenClaims,
  authenticateSessionRequest,
} from './session-tokens.ts';

// Account linking (link tickets, link codes, KV cache, link/list/unlink)
export type {
  AccountStateStorage,
  LoginAccountResolution,
  ResolveLoginAccountOptions,
  LinkProviderOutcome,
  LinkTicket,
  LinkTicketBinding,
  StashedProviderIdentity,
  ConfirmAccountLinkOptions,
  ConfirmAccountLinkResult,
  LinkedAccountSummary,
  UnlinkProviderResult,
  UnlinkProviderAccountOptions,
} from './account-linking.ts';
export {
  LINK_TICKET_LIFETIME_SECONDS,
  LINK_CODE_LIFETIME_SECONDS,
  linkTicketStorageKey,
  linkCodeStorageKey,
  accountCacheStorageKey,
  createLinkTicket,
  consumeLinkTicket,
  stashLinkCode,
  consumeLinkCode,
  confirmAccountLink,
  rememberAccountUUID,
  recallAccountUUID,
  forgetAccountUUID,
  resolveLoginAccount,
  linkProviderAccount,
  listLinkedAccounts,
  unlinkProviderAccount,
} from './account-linking.ts';

// Request policy the OAuth provider workers apply before touching KV/Supabase
export {
  isValidOAuthState,
  parseAllowedOrigins,
  isAllowedRedirectURI,
} from './oauth-request-policy.ts';

// Account management routes shared by the OAuth provider workers
export type {
  AccountRouteRequest,
  AccountRouteDependencies,
  AccountRouteResult,
} from './account-routes.ts';
export {
  ACCOUNTS_PATHNAME,
  ACCOUNTS_PATHNAME_PREFIX,
  ACCOUNT_LINK_CONFIRM_PATHNAME,
  LINK_TICKETS_PATHNAME,
  accountRouteRequiresBody,
  isAccountRoutePathname,
  handleAccountRoute,
} from './account-routes.ts';

// Crawler operations
export type { PaginatedCrawlers } from './crawlers.ts';
export {
  SYSTEM_USER_UUID,
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  getCrawlerByID,
  getSystemCrawlerByName,
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
export type { PaginatedSchedulers, SchedulerNextRunUpdate } from './schedulers.ts';
export {
  createScheduler,
  listSchedulersByUser,
  getScheduler,
  getSchedulerByID,
  listSchedulersDue,
  listSchedulersWithoutNextRun,
  setSchedulerNextRuns,
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
  getSchedulerRunByID,
  getSchedulerRunByOccurrence,
  listActiveSchedulerRunsBefore,
  failSchedulerRuns,
  updateSchedulerRun,
  listSchedulerRuns,
} from './scheduler-runs.ts';

// Scheduler stage run operations
export {
  createSchedulerStageRun,
  getSchedulerStageRun,
  getSchedulerStageRunByID,
  getSchedulerStageRunByStage,
  updateSchedulerStageRun,
  listSchedulerStageRunsByRun,
  listSchedulerStageRunSummaries,
  setSchedulerStageRunProgress,
  failActiveSchedulerStageRuns,
} from './scheduler-stage-runs.ts';

// Task group operations
export {
  listTaskGroups,
  getTaskGroup,
} from './task-groups.ts';
