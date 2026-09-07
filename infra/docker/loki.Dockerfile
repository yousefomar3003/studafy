# Loki, with this repo's own config baked in (ST-261: log aggregation pipeline).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/loki.Dockerfile -t studafy/loki .
#
# loki-config.yml.tpl is static except for four per-environment values (LOKI_PORT,
# LOKI_CHUNKS_BUCKET, AWS_REGION, LOKI_RETENTION) that a shell entrypoint expands with envsubst at
# container start — the same "one templated file, plain-shell/envsubst entrypoint" shape as
# infra/docker/grafana.Dockerfile. gettext (envsubst) installs cleanly on the upstream image's
# Alpine base.
#
# The upstream image's own loki binary, `loki` user and directory layout are left alone; this
# layers config on top, same as infra/docker/prometheus.Dockerfile / grafana.Dockerfile.

ARG LOKI_VERSION=3.5.1

FROM grafana/loki:${LOKI_VERSION}

USER root
RUN apk add --no-cache gettext

COPY --chmod=644 infra/docker/loki/loki-config.yml.tpl /etc/loki/loki-config.yml.tpl
COPY --chmod=755 infra/docker/loki/docker-entrypoint.sh /docker-entrypoint.sh

USER loki

ENTRYPOINT ["/docker-entrypoint.sh"]
