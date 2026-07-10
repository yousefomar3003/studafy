# apps/workers — BullMQ job consumers on Bun. No HTTP server (see apps/workers/src/index.ts):
# this process only holds Redis connections and runs queue handlers.
#
# Build from the repo root:
#   docker build -f infra/docker/workers.Dockerfile -t studafy/workers .
#
# apps/workers depends on the workspace package @studafy/constants (see
# apps/workers/package.json), but `bun build --target bun` bundles it (and every other
# dependency) directly into apps/workers/dist/index.js — the runtime stage copies only that file,
# never node_modules.

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# See infra/docker/api.Dockerfile for why this is a single COPY rather than a manifest-first split.
COPY . .

# --ignore-scripts: see infra/docker/api.Dockerfile — same reasoning, no dependency here needs a
# postinstall script.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# turbo builds @studafy/constants first (turbo.json: dependsOn ["^build"]) because
# apps/workers/package.json declares it as a dependency, then apps/workers itself.
RUN bunx turbo run build --filter=@studafy/workers

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

# WORKDIR itself is chowned, not just the dist/ copied into it — see infra/docker/api.Dockerfile
# for why: Bun's `--target bun` bundle output writes to its current working directory on startup,
# independent of the app's own code.
RUN addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app app \
    && chown app:app /app

COPY --from=build --chown=app:app /app/apps/workers/dist ./dist
COPY --chown=app:app infra/docker/workers/healthcheck.ts ./healthcheck.ts

USER app

ENV NODE_ENV=production

# apps/workers exposes no HTTP or IPC surface (by design — it is a queue consumer, not a
# service), so there is no endpoint of its own to probe. This instead independently re-checks the
# one thing that actually threatens the process: whether REDIS_URL is reachable. See
# infra/docker/workers/healthcheck.ts for why this doesn't reuse the app's own ioredis connection,
# and infra/docker/README.md for what this check does and does not prove.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun healthcheck.ts

ENTRYPOINT ["bun", "dist/index.js"]
