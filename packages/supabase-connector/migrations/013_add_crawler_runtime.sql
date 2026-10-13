-- Migration: Crawler runtime
-- Crawler code now runs in a Dynamic Worker of the crawler manager, where it can
-- log, call external APIs and leave files. This adds the logs of a stage run,
-- the record of a direct crawler run, and the files a crawler leaves, with the
-- queue that removes their objects from R2.

-- What the crawler code logged while a stage ran. NULL for a stage that ran no
-- crawler code (a task group stage, or a call that failed before running).
ALTER TABLE scheduler_stage_runs
  ADD COLUMN logs JSONB,
  ADD COLUMN logs_truncated BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT scheduler_stage_runs_logs_check CHECK (logs IS NULL OR jsonb_typeof(logs) = 'array');

-- One row per direct run of a crawler (POST /crawlers/:id/runs).
CREATE TABLE crawler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  crawler_id UUID NOT NULL REFERENCES crawlers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  result JSONB,
  error_code TEXT,
  error TEXT,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(logs) = 'array'),
  logs_truncated BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at >= started_at),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

CREATE INDEX crawler_runs_crawler_id_created_at_index ON crawler_runs (crawler_id, created_at DESC);
CREATE INDEX crawler_runs_user_uuid_index ON crawler_runs (user_uuid);
ALTER TABLE crawler_runs ENABLE ROW LEVEL SECURITY;

-- Files a crawler saved. The object itself is in R2 under object_key.
CREATE TABLE crawler_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  run_id UUID REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  crawler_id UUID REFERENCES crawlers(id) ON DELETE SET NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
  size BIGINT NOT NULL CHECK (size >= 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A file of a scheduled run goes with its run; a file of a direct run goes at its expiry
  CONSTRAINT crawler_files_lifetime_check CHECK ((run_id IS NULL) = (expires_at IS NOT NULL))
);

CREATE INDEX crawler_files_user_uuid_index ON crawler_files (user_uuid);
CREATE INDEX crawler_files_run_id_index ON crawler_files (run_id);
CREATE INDEX crawler_files_expires_at_index ON crawler_files (expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE crawler_files ENABLE ROW LEVEL SECURITY;

-- R2 object keys of deleted file rows, removed from R2 by the crawler manager cron.
CREATE TABLE crawler_file_deletions (
  object_key TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX crawler_file_deletions_queued_at_index ON crawler_file_deletions (queued_at);
ALTER TABLE crawler_file_deletions ENABLE ROW LEVEL SECURITY;

-- Every way a file row goes (its run, its user, its expiry) queues its object.
CREATE FUNCTION queue_crawler_file_deletion() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.crawler_file_deletions (object_key)
  VALUES (OLD.object_key)
  ON CONFLICT (object_key) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE TRIGGER crawler_files_queue_deletion
  AFTER DELETE ON crawler_files
  FOR EACH ROW EXECUTE FUNCTION queue_crawler_file_deletion();

-- Deletes up to batch_limit expired direct run file rows and returns how many it deleted
CREATE FUNCTION delete_expired_crawler_files(batch_limit INTEGER) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.crawler_files
  WHERE id IN (
    SELECT id FROM public.crawler_files
    WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    ORDER BY expires_at
    LIMIT batch_limit
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Removes the keys already deleted from R2 from the queue
CREATE FUNCTION delete_crawler_file_deletions(object_keys TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.crawler_file_deletions WHERE object_key = ANY (object_keys);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Like 011: only the service role (the workers) may call these functions
REVOKE EXECUTE ON FUNCTION delete_expired_crawler_files(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_crawler_file_deletions(TEXT[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION delete_expired_crawler_files(INTEGER) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION delete_crawler_file_deletions(TEXT[]) FROM anon, authenticated;
    GRANT EXECUTE ON FUNCTION delete_expired_crawler_files(INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION delete_crawler_file_deletions(TEXT[]) TO service_role;
  END IF;
END;
$$;
