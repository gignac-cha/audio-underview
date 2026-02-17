// Types
export type {
  ProviderType,
  UserRow,
  AccountRow,
  CrawlerRow,
  UsersInsert,
  AccountsInsert,
  CrawlersInsert,
  CrawlersUpdate,
  SocialLoginInput,
  SocialLoginResult,
  LinkAccountResult,
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
export {
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  updateCrawler,
  deleteCrawler,
} from './crawlers.ts';
