-- Migration: Crawler test runs
-- A crawler declares the names of the environment variables it uses; only those
-- of the account reach its code. The record of a run now also keeps the test
-- runs of the editor: of a saved crawler with unsaved changes, and of code that
-- has no crawler yet, with the code that ran.

-- The names the crawler code reads from context.environment. The name format is
-- checked by the crawler manager, as for the environment variable API.
ALTER TABLE crawlers
  ADD COLUMN environment_variable_names TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT crawlers_environment_variable_names_check
    CHECK (cardinality(environment_variable_names) <= 100);

-- kind: 'direct' (POST /crawlers/:id/runs) or 'test' (the code of the editor).
-- type: the crawler type of the run; NULL only for the rows of 013.
-- code: the code a test run ran; a direct run ran the code of its crawler.
ALTER TABLE crawler_runs
  ALTER COLUMN crawler_id DROP NOT NULL,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'test')),
  ADD COLUMN type TEXT CHECK (type IS NULL OR type IN ('web', 'data')),
  ADD COLUMN code TEXT,
  ADD CONSTRAINT crawler_runs_test_code_check CHECK ((kind = 'test') = (code IS NOT NULL)),
  ADD CONSTRAINT crawler_runs_direct_crawler_check CHECK (kind = 'test' OR crawler_id IS NOT NULL),
  ADD CONSTRAINT crawler_runs_test_type_check CHECK (kind = 'direct' OR type IS NOT NULL);

-- The test runs of a user without a crawler, newest first
CREATE INDEX crawler_runs_user_uuid_unsaved_created_at_index
  ON crawler_runs (user_uuid, created_at DESC) WHERE crawler_id IS NULL;
