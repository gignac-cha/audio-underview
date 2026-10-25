/**
 * The memory of the newscast templates: the scheduler made for each user and source
 * (`newscast_schedulers`, migration 016), so a user's second newscast from GeekNews runs on the
 * scheduler the first one made instead of making another.
 */

import type { SupabaseClient } from '@audio-underview/supabase-connector';

/** Where the articles of a template come from. */
export const NEWSCAST_TEMPLATE_SOURCES = ['geeknews', 'url', 'text'] as const;

export type NewscastTemplateSource = (typeof NEWSCAST_TEMPLATE_SOURCES)[number];

export function parseTemplateSource(value: unknown): NewscastTemplateSource | undefined {
  return typeof value === 'string' && (NEWSCAST_TEMPLATE_SOURCES as readonly string[]).includes(value)
    ? (value as NewscastTemplateSource)
    : undefined;
}

type NewscastSchedulerRow = {
  user_uuid: string;
  source: NewscastTemplateSource;
  scheduler_id: string;
  created_at: string;
};

/**
 * The `newscast_schedulers` table in the Supabase generic schema shape. The connector's `Database`
 * type does not describe it, so the queries here read the table through this type instead.
 */
type NewscastSchedulerDatabase = {
  public: {
    Tables: {
      newscast_schedulers: {
        Row: NewscastSchedulerRow;
        Insert: Pick<NewscastSchedulerRow, 'user_uuid' | 'source' | 'scheduler_id'>;
        Update: Partial<Omit<NewscastSchedulerRow, 'user_uuid' | 'source' | 'created_at'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};

function newscastSchedulersTable(client: SupabaseClient) {
  return (client as unknown as SupabaseClient<NewscastSchedulerDatabase>).from('newscast_schedulers');
}

/** The scheduler remembered for the user and the source, or `null`. */
export async function readNewscastScheduler(
  client: SupabaseClient,
  userUUID: string,
  source: NewscastTemplateSource,
): Promise<string | null> {
  const { data, error } = await newscastSchedulersTable(client)
    .select('scheduler_id')
    .eq('user_uuid', userUUID)
    .eq('source', source)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to read the newscast scheduler: ${error.message}`);
  }
  return data === null ? null : (data as Pick<NewscastSchedulerRow, 'scheduler_id'>).scheduler_id;
}

/**
 * Forget a scheduler that cannot be used any more. Only the row that still names that scheduler
 * goes: a request that already remembered a new one is not undone.
 */
export async function forgetNewscastScheduler(
  client: SupabaseClient,
  userUUID: string,
  source: NewscastTemplateSource,
  schedulerID: string,
): Promise<void> {
  const { error } = await newscastSchedulersTable(client)
    .delete()
    .eq('user_uuid', userUUID)
    .eq('source', source)
    .eq('scheduler_id', schedulerID);
  if (error) {
    throw new Error(`Failed to forget the newscast scheduler: ${error.message}`);
  }
}

/**
 * Remember a scheduler for the user and the source, unless a row is already there, and answer the
 * scheduler the row names. Two requests that made a scheduler at the same time both get the one that
 * was written first, so the later one knows to throw its own away.
 */
export async function rememberNewscastScheduler(
  client: SupabaseClient,
  userUUID: string,
  source: NewscastTemplateSource,
  schedulerID: string,
): Promise<string> {
  const { error } = await newscastSchedulersTable(client).upsert(
    { user_uuid: userUUID, source, scheduler_id: schedulerID },
    { onConflict: 'user_uuid,source', ignoreDuplicates: true },
  );
  if (error) {
    throw new Error(`Failed to remember the newscast scheduler: ${error.message}`);
  }
  return (await readNewscastScheduler(client, userUUID, source)) ?? schedulerID;
}
