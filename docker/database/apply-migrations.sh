#!/bin/sh
# Applies packages/supabase-connector/migrations to public in number order, each file once.
# Each file runs in one transaction together with its record in migration_history, as the
# production migration workflow applies one file per request. psql reads the connection from the
# PG* environment variables compose sets.
set -eu

MIGRATIONS_DIRECTORY=/migrations

psql --quiet --variable ON_ERROR_STOP=1 <<'SQL'
SET client_min_messages TO warning;
CREATE SCHEMA IF NOT EXISTS migration_history;
CREATE TABLE IF NOT EXISTS migration_history.applied_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

applied_count=0
for file in "$MIGRATIONS_DIRECTORY"/*.sql; do
  name=$(basename "$file")
  # The name goes into SQL as a literal, so only the shape the migration files use is accepted
  case "$name" in
    *[!0-9a-z_.]*)
      echo "Unexpected migration file name: $name" >&2
      exit 1
      ;;
  esac

  applied=$(psql --no-align --tuples-only --variable ON_ERROR_STOP=1 \
    --command "SELECT 1 FROM migration_history.applied_migrations WHERE name = '$name'")
  if [ "$applied" = "1" ]; then
    continue
  fi

  echo "Applying $name"
  psql --quiet --variable ON_ERROR_STOP=1 --single-transaction \
    --file "$file" \
    --command "INSERT INTO migration_history.applied_migrations (name) VALUES ('$name')"
  applied_count=$((applied_count + 1))
done

# PostgREST reloads its schema cache on this notification, so tables a later run adds are served
# without restarting the rest service
psql --quiet --variable ON_ERROR_STOP=1 --command "NOTIFY pgrst, 'reload schema'"
echo "Applied $applied_count migration files"
