# apps/api — Hono HTTP API on Bun.
#
# Build from the repo root so the build stage can reach bun.lock and the workspace packages
# turbo resolves the build graph against:
#   docker build -f infra/docker/api.Dockerfile -t studafy/api .
#
# apps/api has no workspace runtime dependencies (see apps/api/package.json), so `bun build`
# produces a single self-contained apps/api/dist/index.js — the runtime stage copies only that
# file and never installs node_modules, which is what keeps the final image small.

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# Full source is copied in one layer (see .dockerignore for what's excluded). A manifest-only
# COPY-then-source-COPY split was considered for finer-grained layer caching, but it requires
# enumerating every apps/*/package.json and packages/*/package.json path in every one of the four
# Dockerfiles and re-editing all of them whenever a workspace member is added or removed — the
# cache mount below already makes repeat installs fast without that duplication.
COPY . .

# --ignore-scripts: the root package.json's "prepare" script runs `lefthook install`, which
# expects a .git directory that .dockerignore deliberately excludes from the build context (and
# which a container has no use for regardless). No dependency in this workspace needs an install
# script to become usable — esbuild (via vite) resolves its platform binary through
# optionalDependencies, not postinstall; verified locally with the same flag before adding it
# here.
#
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

# Build workspace dependencies first so generate step can resolve them.
# turbo's dependsOn: ["^build"] should handle this transitively, but turbo 2.10.3
# has a bug where @studafy/shared-schemas:build and @studafy/attendance-reporting:build
# are not scheduled when using filters.
RUN bun run --cwd packages/constants build \
 && bun run --cwd packages/shared-schemas build \
 && bun run --cwd packages/attendance-reporting build \
 && bun run --cwd packages/finance-reporting build
RUN bunx turbo run build --filter=@studafy/api

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

# Fixed uid/gid rather than relying on whatever non-root user (if any) ships in the upstream
# image, so the runtime identity is a property of this Dockerfile, not of oven/bun's internals.
# WORKDIR itself is chowned, not just the dist/ copied into it: Bun's `--target bun` bundle
# output writes to its current working directory on startup (confirmed empirically — a root-owned
# CWD makes even a plain `bun dist/index.js` fail with "bun is unable to write files: AccessDenied"
# before the app's own code runs), so the directory the process starts in must be writable by the
# user it runs as, independent of which files happen to live there.
RUN addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app app \
    && chown app:app /app

COPY --from=build --chown=app:app /app/apps/api/dist ./dist

USER app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

# No curl/wget dependency: bun's own fetch is always present in this image, so the check needs
# nothing the alpine base doesn't already have. Liveness only (mirrors /healthz's own contract,
# see apps/api/src/health.ts) — it does not assert readiness (/readyz).
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "dist/index.js"]
