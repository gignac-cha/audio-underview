-- Migration: Create crawlers table for storing user-defined crawlers

-- Crawlers table
-- Each crawler belongs to a user and contains code to process matched URLs
CREATE TABLE crawlers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url_pattern TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient user lookup
CREATE INDEX crawlers_user_uuid_index ON crawlers(user_uuid);

-- Comments for documentation
COMMENT ON TABLE crawlers IS 'User-defined crawlers that process matched URLs';
COMMENT ON COLUMN crawlers.user_uuid IS 'Reference to the owning user account';
COMMENT ON COLUMN crawlers.name IS 'Human-readable name for the crawler';
COMMENT ON COLUMN crawlers.url_pattern IS 'Regex pattern to match URLs this crawler should process';
COMMENT ON COLUMN crawlers.code IS 'JavaScript code to execute against fetched page content';
