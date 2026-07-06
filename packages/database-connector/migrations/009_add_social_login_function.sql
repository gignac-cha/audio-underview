-- Migration: Transactional social login RPC
-- Replaces the application-level two-step user+account creation (with manual
-- rollback) by a single atomic function. PostgREST wraps RPC calls in a
-- transaction, so a failure at any point rolls back both inserts.

CREATE OR REPLACE FUNCTION social_login(
  p_provider provider_type,
  p_identifier TEXT
) RETURNS TABLE(user_uuid UUID, is_new_user BOOLEAN, is_new_account BOOLEAN) AS $$
DECLARE
  existing_uuid UUID;
  created_uuid UUID;
BEGIN
  SELECT accounts.uuid
  INTO existing_uuid
  FROM accounts
  WHERE accounts.provider = p_provider
    AND accounts.identifier = p_identifier;

  IF existing_uuid IS NOT NULL THEN
    RETURN QUERY SELECT existing_uuid, false, false;
    RETURN;
  END IF;

  INSERT INTO users DEFAULT VALUES
  RETURNING users.uuid INTO created_uuid;

  INSERT INTO accounts (provider, identifier, uuid)
  VALUES (p_provider, p_identifier, created_uuid);

  RETURN QUERY SELECT created_uuid, true, true;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION social_login IS 'Atomically find or create the user+account pair for a social login. Returns the user uuid with new-user/new-account flags.';
