ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
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
