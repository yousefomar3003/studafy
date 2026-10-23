# Alertmanager, with this repo's own routing config baked in (ST-262: alerting and on-call).
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/alertmanager.Dockerfile -t studafy/alertmanager .
#
# alertmanager.yml's only per-environment values are the SNS region and receiver topic ARNs, which
# docker-entrypoint.sh substitutes from the task's environment at container start. See that
# script's header for why sed rather than the envsubst templating infra/docker/loki.Dockerfile uses
# (short version: the busybox base has no package manager).
#
# The upstream image's own alertmanager binary, `nobody` user and /alertmanager storage directory
# are left alone; this layers config on top of it, the same shape as
# infra/docker/prometheus.Dockerfile.

ARG ALERTMANAGER_VERSION=v0.28.1

FROM prom/alertmanager:${ALERTMANAGER_VERSION}

COPY --chmod=644 infra/docker/alertmanager/alertmanager.yml /etc/alertmanager/alertmanager.yml
COPY --chmod=644 infra/docker/alertmanager/studafy.tmpl /etc/alertmanager/studafy.tmpl
COPY --chmod=755 infra/docker/alertmanager/docker-entrypoint.sh /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
