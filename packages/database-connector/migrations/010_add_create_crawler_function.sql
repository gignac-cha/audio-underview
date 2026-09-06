-- Migration: Transactional crawler creation RPC
-- Replaces the application-level two-step crawler+owner-permission creation by
-- a single atomic function so a crawler row can never exist without its owner
-- permission row.

CREATE OR REPLACE FUNCTION create_crawler_with_owner_permission(
  p_user_uuid UUID,
  p_name TEXT,
  p_type crawler_type,
  p_url_pattern TEXT,
  p_code TEXT,
  p_input_schema JSONB,
  p_output_schema JSONB
) RETURNS SETOF crawlers AS $$
DECLARE
  created_id UUID;
BEGIN
  INSERT INTO crawlers (user_uuid, name, type, url_pattern, code, input_schema, output_schema)
  VALUES (p_user_uuid, p_name, p_type, p_url_pattern, p_code, p_input_schema, p_output_schema)
  RETURNING id INTO created_id;

  INSERT INTO crawler_permissions (crawler_id, user_uuid, level)
  VALUES (created_id, p_user_uuid, 'owner');

  RETURN QUERY
    SELECT * FROM crawlers WHERE id = created_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_crawler_with_owner_permission IS 'Atomically create a crawler together with its owner permission row.';
