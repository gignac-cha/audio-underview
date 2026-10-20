-- Migration: User vault tables
-- The user vault worker kept the provider keys of the users, their audit log
-- and the environment variables of the users in a D1 database of its own. They
-- move here, so each environment keeps them in its own schema next to its other
-- data. The vault seals every value before it reaches a row (a data key per row,
-- wrapped by the vault's key encryption key), so the rows hold base64 text only.
-- Each environment seals with its own key encryption key, so these rows are
-- never copied from one schema to another.
--
-- The times are TEXT, not TIMESTAMPTZ: an envelope binds the time it was sealed
-- (created_at of a provider key, updated_at of an environment variable) into
-- its additional authenticated data, so the value has to come back exactly as
-- the vault wrote it, an ISO 8601 string ending in Z. PostgREST would answer a
-- TIMESTAMPTZ with +00:00 and the envelope would no longer open.

-- One sealed provider key per user and provider
CREATE TABLE provider_keys (
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  dek_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  last4 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_at TEXT,
  PRIMARY KEY (user_id, provider)
);

COMMENT ON TABLE provider_keys IS 'Provider (AI API) keys of the users, sealed by the user vault worker';
COMMENT ON COLUMN provider_keys.provider IS 'Provider name; a row of a provider the vault no longer knows is ignored';
COMMENT ON COLUMN provider_keys.ciphertext IS 'The key encrypted with the data key of the row (AES-GCM, base64)';
COMMENT ON COLUMN provider_keys.wrapped_dek IS 'The data key of the row encrypted with the key encryption key (base64)';
COMMENT ON COLUMN provider_keys.key_version IS 'Generation of the key encryption key the row was sealed with';
COMMENT ON COLUMN provider_keys.last4 IS 'Last four characters of the key, shown to the user';
COMMENT ON COLUMN provider_keys.created_at IS 'When the envelope was sealed (ISO 8601); part of its authenticated data';

-- What happened to the provider keys of a user. The vault only appends and reads.
CREATE TABLE key_audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL,
  ip_hash TEXT,
  ua_hash TEXT
);

-- The events of a user, newest first
CREATE INDEX key_audit_log_user_id_id_index ON key_audit_log (user_id, id DESC);

COMMENT ON TABLE key_audit_log IS 'Registered, replaced, removed and used events of the provider keys';
COMMENT ON COLUMN key_audit_log.at IS 'When it happened (ISO 8601, as the vault wrote it)';
COMMENT ON COLUMN key_audit_log.ip_hash IS 'Salted SHA-256 of the IP address of the request, NULL when it had none';
COMMENT ON COLUMN key_audit_log.ua_hash IS 'Salted SHA-256 of the user agent of the request, NULL when it had none';

-- One sealed environment variable per user and name. The name format is checked
-- by the vault. It compares and sorts byte by byte (COLLATE "C"), as it did in
-- D1, so a list by name keeps its order whatever the collation of the database.
CREATE TABLE environment_variables (
  user_id UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  name TEXT COLLATE "C" NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  dek_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

COMMENT ON TABLE environment_variables IS 'Environment variables of the users, sealed by the user vault worker; their crawlers read them by name';
COMMENT ON COLUMN environment_variables.created_at IS 'When the variable was first stored (ISO 8601)';
COMMENT ON COLUMN environment_variables.updated_at IS 'When the value was last sealed (ISO 8601); part of the authenticated data of its envelope';

-- Only the vault (service role) uses these tables.
ALTER TABLE provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE key_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE environment_variables ENABLE ROW LEVEL SECURITY;

-- Inserts one environment variable while the user has fewer than maximum_count,
-- as the one D1 statement did. variable holds the columns of the row. The row of
-- the user is locked first, so two inserts of the same user count one after the
-- other. A name the user has already is left alone. Returns whether the row was
-- inserted.
CREATE FUNCTION insert_environment_variable(variable JSONB, maximum_count INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
SET search_path = ''
AS $$
  SELECT 1 FROM public.users WHERE uuid = (variable ->> 'user_id')::UUID FOR NO KEY UPDATE;
  WITH inserted AS (
    INSERT INTO public.environment_variables (user_id, name, ciphertext, iv, wrapped_dek, dek_iv, key_version, created_at, updated_at)
    SELECT
      requested.user_id, requested.name, requested.ciphertext, requested.iv, requested.wrapped_dek,
      requested.dek_iv, requested.key_version, requested.created_at, requested.updated_at
    FROM jsonb_populate_record(NULL::public.environment_variables, variable) AS requested
    WHERE (SELECT COUNT(*) FROM public.environment_variables AS existing WHERE existing.user_id = requested.user_id) < maximum_count
    ON CONFLICT (user_id, name) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM inserted);
$$;

-- Supabase gives tables created from here on no privileges, so the vault's role
-- gets them here. The audit log is only appended to and read, so the privileges
-- the default privileges of the schema may have given are taken back first.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE provider_keys TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE environment_variables TO service_role;
REVOKE ALL ON TABLE key_audit_log FROM service_role;
GRANT SELECT, INSERT ON TABLE key_audit_log TO service_role;

-- Like 011 and 013: only the service role may call the function
REVOKE EXECUTE ON FUNCTION insert_environment_variable(JSONB, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_environment_variable(JSONB, INTEGER) TO service_role;

-- The public anon and authenticated keys must never reach these rows, whatever
-- the default privileges of the schema gave them. The roles exist on Supabase
-- and in the docker database only, hence the check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE provider_keys, key_audit_log, environment_variables FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION insert_environment_variable(JSONB, INTEGER) FROM anon, authenticated;
  END IF;
END;
$$;
