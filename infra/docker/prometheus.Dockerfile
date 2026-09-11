# Prometheus, with this repo's own scrape config and alert rules baked in (ST-259 "dashboards/
# config in repo", ST-262 alert rules).
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
# Alert rules (ST-262), baked in beside the scrape config and for the same reason: they reference
# only metric names and fixed thresholds, nothing that varies per environment. Shipping a rule
# change is a `prometheus_image_tag` bump and a `terraform apply`, exactly like a scrape-config
# change. prometheus.yml's `rule_files` globs this directory.
#
# Note the absent `--chmod`, unlike every single-file COPY in this directory. Docker applies
# `--chmod` to the destination *directory* it creates as well as to the files, and a directory
# without its execute bit cannot be traversed — `--chmod=644` here makes every file inside
# unreadable, to root included, and a `*.yml` glob does not avoid it. Plain COPY gives the
# directory 0755 and the files their source mode, which is what is wanted. Verified with
# `promtool check config` inside the built image. The same mistake is fixed in
# grafana.Dockerfile, where it had been silently breaking dashboard provisioning since ST-259.
COPY infra/docker/prometheus/rules/ /etc/prometheus/rules/
COPY --chmod=755 infra/docker/prometheus/docker-entrypoint.sh /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
