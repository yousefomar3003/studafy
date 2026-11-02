#!/bin/sh
# PROMETHEUS_RETENTION is the one thing this image's config cannot bake statically — it's a
# per-environment tuning knob (modules/monitoring's prometheus_retention variable), not a value
# tied to a fixed DNS name the way prometheus.yml's scrape targets are. A shell entrypoint, not an
# exec-form CMD in the Dockerfile, is what lets $PROMETHEUS_RETENTION actually expand — Docker
# never runs a shell over exec-form arguments.
set -eu

exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time="${PROMETHEUS_RETENTION:-15d}" \
  --web.listen-address=:9090
