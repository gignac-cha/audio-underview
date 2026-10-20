# Images of the workers and web services of docker/compose.yaml (build context: repository root).
# Both hold the whole pnpm workspace with its dependencies. Secrets are not part of them: they come
# in at run time through docker/.env.docker.

# workerd needs glibc, so the image is Debian based rather than Alpine
FROM node:26-trixie-slim AS workspace

# workerd checks TLS against the system certificate store, which the slim image does not have. Without
# it every https request of a worker fails (sign-in token exchange, code runner function, Axiom).
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Node 25 and later no longer ship corepack, so pnpm is installed with npm, at the version the root
# package.json names in packageManager
RUN npm install --global pnpm@10.26.1

WORKDIR /workspace

# The store is filled from the lockfile alone, so this layer is reused until pnpm-lock.yaml changes
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --frozen-lockfile --offline

# Five wrangler dev processes in one container (see docker/workers/start-workers.ts)
FROM workspace AS workers
ENV WRANGLER_SEND_METRICS=false \
    WRANGLER_SEND_ERROR_REPORTS=false
CMD ["node", "docker/workers/start-workers.ts"]

# Vite dev server of applications/web
FROM workspace AS web
CMD ["sh", "docker/web/start-web.sh"]
