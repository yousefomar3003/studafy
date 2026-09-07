#!/bin/sh
# LOKI_PORT / LOKI_CHUNKS_BUCKET / AWS_REGION / LOKI_RETENTION are the only per-environment values
# in loki-config.yml.tpl (infra/terraform/modules/logging/loki.tf supplies them). envsubst fills
# just those four — named explicitly so a literal ${...} anywhere else in the file is left alone —
# then this execs Loki. Rendered to /tmp because the upstream image's `loki` user does not own
# /etc/loki.
set -eu

envsubst '${LOKI_PORT} ${LOKI_CHUNKS_BUCKET} ${AWS_REGION} ${LOKI_RETENTION}' \
  < /etc/loki/loki-config.yml.tpl \
  > /tmp/loki-config.yml

exec /usr/bin/loki -config.file=/tmp/loki-config.yml -target=all
