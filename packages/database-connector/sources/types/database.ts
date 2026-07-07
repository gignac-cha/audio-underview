/*
 * supabase-js의 `Database` 제네릭은 테이블 Row/Insert/Update가 인덱스 제약을
 * 만족해야 추론이 동작한다. `interface`로 바꾸면 암묵적 인덱스 시그니처가 없어
 * 전 쿼리가 `never`로 fallback되므로, 이 파일은 반드시 `type` alias를 쓴다.
 */
/* eslint-disable @typescript-eslint/consistent-type-definitions */
import type {
  Crawler,
  CrawlerPermission,
  CrawlerPermissionLevel,
  CrawlerType,
  FanOutStrategy,
  OAuthProviderID,
  PlainObject,
  Scheduler,
  SchedulerRun,
  SchedulerRunStatus,
  SchedulerStage,
  SchedulerStageRun,
} from '@audio-underview/schemas';

/**
 * Supabase `Database` generic — 스키마 계약은 migrations/ 와 1:1.
 * Row 타입은 `@audio-underview/schemas`의 API entity와 동일한 shape를 공유한다
 * (DB 행 = API 표현이라는 레거시 계약 유지).
 */

export type UserRow = { uuid: string; created_at: string };
export type UsersInsert = { uuid?: string; created_at?: string };

export type AccountRow = {
  provider: OAuthProviderID;
  identifier: string;
  uuid: string;
  created_at: string;
};
export type AccountsInsert = {
  provider: OAuthProviderID;
  identifier: string;
  uuid: string;
  created_at?: string;
};

export type CrawlerRow = Crawler;
export type CrawlersInsert = {
  id?: string;
  user_uuid: string;
  name: string;
  type?: CrawlerType;
  url_pattern?: string | null;
  code: string;
  input_schema?: PlainObject;
  output_schema?: PlainObject;
};
export type CrawlersUpdate = Partial<Omit<CrawlersInsert, 'id' | 'user_uuid'>>;

export type SchedulerRow = Scheduler;
export type SchedulersInsert = {
  id?: string;
  user_uuid: string;
  name: string;
  cron_expression?: string | null;
  is_enabled?: boolean;
  last_run_at?: string | null;
};
export type SchedulersUpdate = Partial<Omit<SchedulersInsert, 'id' | 'user_uuid'>>;

export type SchedulerStageRow = SchedulerStage;
export type SchedulerStagesInsert = {
  id?: string;
  scheduler_id: string;
  crawler_id: string;
  stage_order: number;
  input_schema: PlainObject;
  output_schema?: PlainObject;
  fan_out_field?: string | null;
  fan_out_strategy?: FanOutStrategy;
};
export type SchedulerStagesUpdate = Partial<Omit<SchedulerStagesInsert, 'id' | 'scheduler_id'>>;

export type SchedulerRunRow = SchedulerRun;
export type SchedulerRunsInsert = {
  id?: string;
  scheduler_id: string;
  status?: SchedulerRunStatus;
  started_at?: string | null;
  completed_at?: string | null;
  result?: unknown;
  error?: string | null;
};
export type SchedulerRunsUpdate = Partial<Omit<SchedulerRunsInsert, 'id' | 'scheduler_id'>>;

export type SchedulerStageRunRow = SchedulerStageRun;
export type SchedulerStageRunsInsert = {
  id?: string;
  run_id: string;
  stage_id: string;
  stage_order: number;
  status?: SchedulerRunStatus;
  started_at?: string | null;
  completed_at?: string | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  items_total?: number | null;
  items_succeeded?: number | null;
  items_failed?: number | null;
};
export type SchedulerStageRunsUpdate = Partial<
  Omit<SchedulerStageRunsInsert, 'id' | 'run_id' | 'stage_id'>
>;

export type CrawlerPermissionRow = CrawlerPermission;
export type CrawlerPermissionsInsert = {
  id?: string;
  crawler_id: string;
  user_uuid: string;
  level: CrawlerPermissionLevel;
};

interface TableDefinition<Row, Insert, Update> {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
}

export interface Database {
  public: {
    Tables: {
      users: TableDefinition<UserRow, UsersInsert, Partial<UsersInsert>>;
      accounts: TableDefinition<AccountRow, AccountsInsert, Partial<AccountsInsert>>;
      crawlers: TableDefinition<CrawlerRow, CrawlersInsert, CrawlersUpdate>;
      schedulers: TableDefinition<SchedulerRow, SchedulersInsert, SchedulersUpdate>;
      scheduler_stages: TableDefinition<
        SchedulerStageRow,
        SchedulerStagesInsert,
        SchedulerStagesUpdate
      >;
      scheduler_runs: TableDefinition<SchedulerRunRow, SchedulerRunsInsert, SchedulerRunsUpdate>;
      scheduler_stage_runs: TableDefinition<
        SchedulerStageRunRow,
        SchedulerStageRunsInsert,
        SchedulerStageRunsUpdate
      >;
      crawler_permissions: TableDefinition<
        CrawlerPermissionRow,
        CrawlerPermissionsInsert,
        Partial<CrawlerPermissionsInsert>
      >;
    };
    Views: Record<string, never>;
    Functions: {
      reorder_scheduler_stages: {
        Args: { p_scheduler_id: string; p_stage_ids: string[] };
        Returns: SchedulerStageRow[];
      };
      social_login: {
        Args: { p_provider: OAuthProviderID; p_identifier: string };
        Returns: { user_uuid: string; is_new_user: boolean; is_new_account: boolean }[];
      };
      create_crawler_with_owner_permission: {
        Args: {
          p_user_uuid: string;
          p_name: string;
          p_type: CrawlerType;
          p_url_pattern: string | null;
          p_code: string;
          p_input_schema: PlainObject;
          p_output_schema: PlainObject;
        };
        Returns: CrawlerRow[];
      };
    };
    Enums: {
      provider_type: OAuthProviderID;
      crawler_type: CrawlerType;
      scheduler_run_status: SchedulerRunStatus;
      crawler_permission_level: CrawlerPermissionLevel;
      fan_out_strategy: FanOutStrategy;
    };
    CompositeTypes: Record<string, never>;
  };
}
