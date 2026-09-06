-- Migration: Create users and accounts tables for social login integration
-- Run this in Supabase SQL Editor or via migrations

-- Provider enum type
-- Includes all supported OAuth providers
CREATE TYPE provider_type AS ENUM (
  'google',
  'github',
  'apple',
  'microsoft',
  'facebook',
  'x',
  'linkedin',
  'discord',
  'kakao',
  'naver'
);

-- Users table (integrated accounts)
-- Each user can have multiple social login accounts
CREATE TABLE users (
  uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Accounts table (social login accounts)
-- Links social provider accounts to users
CREATE TABLE accounts (
  provider provider_type NOT NULL,
  identifier TEXT NOT NULL,
  uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, identifier)
);

-- Index for efficient user lookup
CREATE INDEX accounts_uuid_index ON accounts(uuid);

-- Comments for documentation
COMMENT ON TABLE users IS 'Integrated user accounts that can have multiple social login providers';
COMMENT ON TABLE accounts IS 'Social login accounts linked to users';
COMMENT ON COLUMN accounts.provider IS 'OAuth provider type (google, github, etc.)';
COMMENT ON COLUMN accounts.identifier IS 'Provider-specific unique identifier (sub for Google, id for GitHub, etc.)';
COMMENT ON COLUMN accounts.uuid IS 'Reference to the integrated user account';
