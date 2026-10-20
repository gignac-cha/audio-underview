#!/bin/sh
# Creates the roles a Supabase project has, so PostgREST and the migrations behave as on Supabase.
# The official Postgres image runs this once, as the postgres superuser, on an empty data directory.
#
# - anon, authenticated, service_role: the roles a request runs as; they cannot log in.
# - service_role bypasses row level security, as the workers' secret key does on Supabase.
# - authenticator: the login PostgREST uses; it switches to the role named in the request's JWT.
set -eu

psql --variable ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --variable authenticator_password="$AUTHENTICATOR_PASSWORD" <<'SQL'
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD :'authenticator_password';
GRANT anon, authenticated, service_role TO authenticator;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- The migrate service runs the migrations as postgres. Objects postgres creates in public from now
-- on are usable by service_role without a GRANT in the migration.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
SQL
