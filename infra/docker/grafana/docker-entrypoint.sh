#!/bin/sh
# AWS_REGION is the one value in provisioning/datasources/datasources.yml.tpl that genuinely
# varies per environment (module.monitoring's aws_region input) — everything else in this image's
# provisioning is static. envsubst fills it in once, at container start, then this hands off to
# the upstream image's own entrypoint so Grafana's normal GF_*-env-var configuration still works
# unmodified.
set -eu

envsubst '${AWS_REGION}' \
  < /etc/grafana/provisioning/datasources/datasources.yml.tpl \
  > /etc/grafana/provisioning/datasources/datasources.yml

exec /run.sh "$@"
