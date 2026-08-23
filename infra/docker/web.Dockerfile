# apps/web — Vite/React SPA, built to a static bundle and served by nginx (no Bun runtime in the
# final image; nothing in this app runs server-side JavaScript).
#
# Build from the repo root:
#   docker build -f infra/docker/web.Dockerfile -t studafy/web .

ARG BUN_VERSION=1.3.14
ARG NGINX_VERSION=1.27-alpine

FROM oven/bun:${BUN_VERSION}-alpine AS build
WORKDIR /app

# Baked into the bundle at build time (Vite inlines `import.meta.env.VITE_*` at build, not runtime —
# unlike the ECS services, a static SPA has no server process left to read an env var from after
# this point). VITE_RELEASE_VERSION is normally the same immutable image tag `release.yml` pushes to
# ECR, so a captured error's Sentry release lines up with the deploy that shipped it (see
# `apps/web/src/lib/monitoring/config.ts`); VITE_SENTRY_DSN, SENTRY_ORG, and SENTRY_PROJECT go
# unset in the `containers.yml` validation build, which is fine — see that file's own doc comment on
# degrading to "monitoring disabled" without one. SENTRY_AUTH_TOKEN is deliberately not an ARG (ARGs
# land in the image's build history): it is mounted as a BuildKit secret, in scope only for the RUN
# step that actually runs `vite build`.
ARG VITE_RELEASE_VERSION=unknown
ARG VITE_SENTRY_DSN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV VITE_RELEASE_VERSION=${VITE_RELEASE_VERSION} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    SENTRY_ORG=${SENTRY_ORG} \
    SENTRY_PROJECT=${SENTRY_PROJECT}

# See infra/docker/api.Dockerfile for why this is a single COPY rather than a manifest-first split.
COPY . .

# --ignore-scripts: see infra/docker/api.Dockerfile — same reasoning, no dependency here needs a
# postinstall script (including vite's esbuild, which resolves its platform binary through
# optionalDependencies, not postinstall).
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

# Pre-build workspace deps that turbo fails to schedule in filtered runs (turbo 2.10.3 bug).
RUN bun run --cwd packages/constants build \
 && bun run --cwd packages/shared-schemas build \
 && bun run --cwd packages/attendance-reporting build
# turbo builds @studafy/ui first (turbo.json: dependsOn ["^build"]) because
# apps/web/package.json declares it as a dependency, then apps/web's `vite build` itself.
#
# The secret mount is optional (id not required): when the caller passes `--secret
# id=sentry_auth_token,...` (release.yml's authenticated release build), the file exists and its
# contents become SENTRY_AUTH_TOKEN for this RUN step only. When it doesn't (containers.yml's
# validation build), the file is simply absent and the `[ -f ... ]` guard leaves the variable unset
# — vite.config.ts's own sentryReleaseUploadEnabled check is what actually turns the upload off.
RUN --mount=type=secret,id=sentry_auth_token \
    if [ -f /run/secrets/sentry_auth_token ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
    fi; \
    bunx turbo run build --filter=@studafy/web

FROM nginx:${NGINX_VERSION} AS runtime

# The pinned nginx:1.27-alpine tag doesn't get rebuilt every time an Alpine security advisory
# lands, so `apk upgrade` pulls in whatever patched package versions the 3.x branch it's built
# from already has published — this is what closed CVE-2026-31789 (OpenSSL libcrypto3/libssl3
# heap overflow) in trivy's scan of an unpatched build of this image.
RUN apk upgrade --no-cache

RUN addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app app \
    # The stock image's nginx.conf starts with `user nginx;`, which only has an effect when the
    # master process itself starts as root and drops privilege to it — this image never runs as
    # root at all (see USER below), so the directive is dead weight that only produces a startup
    # warning ("the 'user' directive makes sense only if the master process runs with super-user
    # privilege") if left in place.
    && sed -i '/^user /d' /etc/nginx/nginx.conf \
    # The master process can't write to the compiled-in default pidfile path (/run/nginx.pid) as
    # a non-root user, so this points the existing `pid` directive's value at /tmp instead — not a
    # `-g "pid ...;"` override on the CMD line, which nginx rejects as a duplicate directive
    # against the one already declared here.
    && sed -i 's#^pid .*;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
    && mkdir -p /tmp/client_temp \
    && chown -R app:app /tmp/client_temp /var/cache/nginx

COPY infra/docker/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=app:app /app/apps/web/dist /usr/share/nginx/html

USER app

EXPOSE 8080

# wget is present via BusyBox on nginx's alpine base — no extra package needed for the probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
