import type {
  AuthenticatedUser,
  Crawler,
  Scheduler,
  SchedulerRun,
  SchedulerStage,
} from '@audio-underview/schemas';
import type { StoredSession } from '../sources/state/session.ts';

export const testUser: AuthenticatedUser = {
  uuid: '11111111-1111-4111-8111-111111111111',
  id: 'google-123',
  email: 'jane@example.com',
  name: 'Jane Doe',
  provider: 'google',
};

export const testSession = (overrides: Partial<StoredSession> = {}): StoredSession => ({
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  expiresAt: Date.now() + 60 * 60 * 1000,
  user: testUser,
  ...overrides,
});

export const testCrawler = (overrides: Partial<Crawler> = {}): Crawler => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_uuid: testUser.uuid,
  name: 'Example crawler',
  type: 'web',
  url_pattern: '^https://example\\.com',
  code: '(input) => ({ title: input })',
  input_schema: {},
  output_schema: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

export const testScheduler = (overrides: Partial<Scheduler> = {}): Scheduler => ({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  user_uuid: testUser.uuid,
  name: 'Daily digest',
  cron_expression: '0 9 * * *',
  is_enabled: true,
  last_run_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

export const testStage = (overrides: Partial<SchedulerStage> = {}): SchedulerStage => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  scheduler_id: testScheduler().id,
  crawler_id: testCrawler().id,
  stage_order: 0,
  input_schema: {},
  output_schema: {},
  fan_out_field: null,
  fan_out_strategy: 'compact',
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const testRun = (overrides: Partial<SchedulerRun> = {}): SchedulerRun => ({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  scheduler_id: testScheduler().id,
  status: 'completed',
  started_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:05.000Z',
  result: { ok: true },
  error: null,
  created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const listEnvelope = <Item>(data: Item[]) => ({
  data,
  total: data.length,
  offset: 0,
  limit: 20,
});
