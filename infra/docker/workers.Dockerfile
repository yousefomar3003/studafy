# apps/workers — BullMQ job consumers on Bun. No HTTP server (see apps/workers/src/index.ts):
# this process only holds Redis connections and runs queue handlers.
#
# Build from the repo root:
#   docker build -f infra/docker/workers.Dockerfile -t studafy/workers .
#
# apps/workers depends on workspace packages such as @studafy/constants and
# @studafy/notification-templates (see apps/workers/package.json), but `bun build --target bun`
# bundles them (and every other dependency) directly into apps/workers/dist/index.js — the runtime
# stage copies only that file, never node_modules.

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# See infra/docker/api.Dockerfile for why this is a single COPY rather than a manifest-first split.
COPY . .

# --ignore-scripts: see infra/docker/api.Dockerfile — same reasoning, no dependency here needs a
# postinstall script.
# Retried, because this step reaches the network and the registry is not perfectly reliable. CI has
# failed here with "Fail extracting tarball" on storybook — a packages/ui devDependency that no
# image in this repo uses at runtime, but which every image installs anyway because
# --frozen-lockfile resolves the whole workspace graph. With fail-fast on the build matrix, one bad
# download turns into six red jobs and a human re-running until the dice land.
#
# Three attempts, 0/5/15s backoff. A genuine lockfile mismatch still fails, just three times slower
# — the right trade, since that case is rare and loud while the flake is common and silent.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    for delay in 0 5 15; do \
      [ "$delay" = 0 ] || { echo "bun install failed; retrying in ${delay}s"; sleep "$delay"; }; \
      bun install --frozen-lockfile --ignore-scripts && exit 0; \
    done; \
    echo "bun install failed after 3 attempts" >&2; exit 1

# Build workspace dependencies first so the turbo filter bug doesn't skip them.
# turbo's dependsOn: ["^build"] should handle this transitively, but turbo 2.10.3
# has a bug where @studafy/shared-schemas:build and @studafy/attendance-reporting:build
# are not scheduled when using filters.
RUN bun run --cwd packages/constants build \
 && bun run --cwd packages/attendance-reporting build \
 && bun run --cwd packages/finance-reporting build \
 && bun run --cwd packages/notification-templates build
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
