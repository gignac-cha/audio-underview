# Images of the database and migrate services of docker/compose.yaml (build context: repository root).

# Postgres with the roles Supabase gives every project. The official image runs the scripts in
# /docker-entrypoint-initdb.d once, as the postgres user, when it creates the data directory in an
# empty volume, and runs a script only when it is executable.
FROM postgres:17-trixie AS database
COPY --chmod=755 docker/database/create-supabase-roles.sh /docker-entrypoint-initdb.d/

# One-shot container that applies the migration files to the database service.
FROM postgres:17-trixie AS migrate
COPY packages/supabase-connector/migrations/ /migrations/
COPY --chmod=755 docker/database/apply-migrations.sh /usr/local/bin/apply-migrations.sh
ENTRYPOINT ["/usr/local/bin/apply-migrations.sh"]
