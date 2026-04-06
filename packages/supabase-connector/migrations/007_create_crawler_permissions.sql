-- Migration: Crawler permission system
-- Controls who can use a crawler in their scheduler stages.
-- Extensible for marketplace subscriptions.

CREATE TYPE crawler_permission_level AS ENUM ('owner', 'subscriber');

CREATE TABLE crawler_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawler_id UUID NOT NULL REFERENCES crawlers(id) ON DELETE CASCADE,
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  level crawler_permission_level NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(crawler_id, user_uuid)
);

CREATE INDEX crawler_permissions_user_uuid_index ON crawler_permissions(user_uuid);
CREATE INDEX crawler_permissions_crawler_id_index ON crawler_permissions(crawler_id);

COMMENT ON TABLE crawler_permissions IS 'Controls access to crawlers. Owner = creator, subscriber = marketplace user.';
COMMENT ON COLUMN crawler_permissions.level IS 'Permission level: owner (full control), subscriber (can use in stages)';

-- Backfill: grant owner permission to existing crawler creators
INSERT INTO crawler_permissions (crawler_id, user_uuid, level)
SELECT id, user_uuid, 'owner'
FROM crawlers
ON CONFLICT (crawler_id, user_uuid) DO NOTHING;
