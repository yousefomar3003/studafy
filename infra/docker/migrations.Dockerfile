ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
COPY . .
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
RUN bunx turbo run build --filter=@studafy/db

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app
RUN addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app app \
    && chown app:app /app
COPY --from=build --chown=app:app /app/packages/db/dist ./packages/db/dist
COPY --from=build --chown=app:app /app/db/migrations ./db/migrations
USER app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/db/migrations
ENTRYPOINT ["bun", "packages/db/dist/cli.js"]
CMD ["migrate"]
