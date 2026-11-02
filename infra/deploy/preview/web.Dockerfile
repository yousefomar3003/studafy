# Preview web image: apps/web's already-built static bundle on a plain nginx, with the preview
# reverse-proxy config from infra/deploy/preview/nginx.conf.
#
# Deliberately NOT infra/docker/web.Dockerfile:
#   - that image bakes its own nginx.conf (no /api proxy) and has no VITE_API_BASE_URL build arg;
#   - the preview bundle needs VITE_API_BASE_URL=/api, which pr-preview.yml sets when it runs
#     `turbo run build --filter=@studafy/web` on the runner, before this image is built.
# So this Dockerfile does no bun install and no vite build — it only packages a dist/ the caller
# has already produced.
#
# It expects a FLAT build context containing exactly two entries — the repo-root .dockerignore
# excludes `**/dist`, so the bundle cannot be COPYed out of a repo-root context. pr-preview.yml
# stages the context like this:
#     mkdir ctx && cp infra/deploy/preview/nginx.conf ctx/ && cp -r apps/web/dist ctx/dist
#     docker build -f infra/deploy/preview/web.Dockerfile -t <registry>/studafy-preview/web:<tag> ctx

ARG NGINX_VERSION=1.27-alpine

FROM nginx:${NGINX_VERSION}

# Same non-root hardening as infra/docker/web.Dockerfile: drop the dead `user` directive, move the
# pidfile somewhere the `app` user can write, pre-create the writable temp dirs.
RUN apk upgrade --no-cache \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app app \
    && sed -i '/^user /d' /etc/nginx/nginx.conf \
    && sed -i 's#^pid .*;#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
    && mkdir -p /tmp/client_temp \
    && chown -R app:app /tmp/client_temp /var/cache/nginx

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=app:app dist /usr/share/nginx/html

USER app

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
