# QA-053: base images are pinned by tag and digest (the multi-arch index), written out in each FROM
# so Dependabot can propose bumps; change both together.

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS build
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

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime
WORKDIR /app

# QA-073: the digest-pinned base keeps the Alpine packages it was published with, so take the
# 3.x branch's published fixes (OpenSSL, musl, zlib) at build time; containers.yml fails the image
# on any fixed HIGH. Same as infra/docker/web.Dockerfile.
RUN apk upgrade --no-cache
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
