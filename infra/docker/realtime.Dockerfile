# apps/realtime — Hono WebSocket gateway on Bun.
#
# Build from the repo root:
#   docker build -f infra/docker/realtime.Dockerfile -t studafy/realtime .
#
# apps/realtime depends on the workspace package @studafy/constants (see
# apps/realtime/package.json), but `bun build --target bun` bundles it (and every other
# dependency) directly into apps/realtime/dist/index.js — the runtime stage copies only that
# file, never node_modules.

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
# apps/realtime/package.json declares it as a dependency, then apps/realtime itself.
RUN bunx turbo run build --filter=@studafy/realtime

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

# WORKDIR itself is chowned, not just the dist/ copied into it — see infra/docker/api.Dockerfile
# for why: Bun's `--target bun` bundle output writes to its current working directory on startup,
# independent of the app's own code.
RUN addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app app \
    && chown app:app /app

COPY --from=build --chown=app:app /app/apps/realtime/dist ./dist

USER app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

EXPOSE 3001

# Liveness only, mirrors /healthz's own contract (apps/realtime/src/health.ts) — does not assert
# readiness (/readyz) or that any WebSocket room state is healthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "dist/index.js"]
