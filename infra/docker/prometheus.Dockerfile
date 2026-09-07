# Prometheus, with this repo's own scrape config baked in (ST-259, "dashboards/config in repo").
#
# Build from the repo root, same convention as every other Dockerfile in this directory
# (infra/docker/README.md's "Why the build context is the repo root"):
#   docker build -f infra/docker/prometheus.Dockerfile -t studafy/prometheus .
#
# prometheus.yml is static, not templated at container start — see its own header comment and
# infra/terraform/modules/monitoring/discovery.tf for why the Cloud Map DNS names it scrapes never
# vary per environment. The only per-environment knob (retention) is a plain environment variable
# a shell entrypoint expands at container start — see docker-entrypoint.sh.
#
# The upstream image's own Prometheus binary, user and default CMD are all left alone; this layers
# config on top of it, the same "no custom build/runtime split, the base image already is the
# runtime" shape as infra/docker/erpnext.Dockerfile.

ARG PROMETHEUS_VERSION=v3.14.0

FROM prom/prometheus:${PROMETHEUS_VERSION}

COPY --chmod=644 infra/docker/prometheus/prometheus.yml /etc/prometheus/prometheus.yml
COPY --chmod=755 infra/docker/prometheus/docker-entrypoint.sh /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
