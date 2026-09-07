# Grafana, with this repo's own datasources, dashboard provisioning, and dashboards baked in
# (ST-259, "dashboards in repo").
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/grafana.Dockerfile -t studafy/grafana .
#
# Everything under infra/docker/grafana/dashboards/ and provisioning/dashboards/ is static — only
# provisioning/datasources/datasources.yml.tpl carries a genuinely per-environment value
# (${AWS_REGION}), expanded by docker-entrypoint.sh at container start. gettext (envsubst) is
# installed here because it installs cleanly on the upstream image's Alpine base — unlike
# infra/docker/prometheus.Dockerfile's busybox base, which has no package manager at all and so
# takes a plain-shell-expansion entrypoint instead.

ARG GRAFANA_VERSION=13.2.1

FROM grafana/grafana:${GRAFANA_VERSION}

USER root
RUN apk add --no-cache gettext

COPY --chmod=644 infra/docker/grafana/provisioning/datasources/datasources.yml.tpl /etc/grafana/provisioning/datasources/datasources.yml.tpl
COPY --chmod=644 infra/docker/grafana/provisioning/dashboards/dashboards.yml /etc/grafana/provisioning/dashboards/dashboards.yml
COPY --chmod=644 infra/docker/grafana/dashboards/ /var/lib/grafana/dashboards/
COPY --chmod=755 infra/docker/grafana/docker-entrypoint.sh /docker-entrypoint.sh

USER grafana

ENTRYPOINT ["/docker-entrypoint.sh"]
