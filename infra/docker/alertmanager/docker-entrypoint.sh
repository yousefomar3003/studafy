#!/bin/sh
# Alertmanager's three receiver URLs are secrets, so alertmanager.yml references them as
# `url_file` paths rather than inline values and this script materialises those files from the
# environment at container start.
#
# Why files and not envsubst (which is how infra/docker/loki/docker-entrypoint.sh handles *its*
# per-environment values): the upstream prom/alertmanager image is busybox-based and has no package
# manager, so there is no envsubst to install — the same constraint infra/docker/prometheus.Docker
# file already notes. But the stronger reason is that it is the better shape here regardless. A
# rendered config containing a live paging URL would sit on disk for the life of the task and show
# up in any `cat` of the config during an incident; `url_file` keeps the secret in one 0600 file
# that Alertmanager re-reads per notification, so a rotated URL needs no rebuild.
#
# The env vars come from the ECS task definition's `secrets` block, resolved from the `monitoring`
# app-secrets container (infra/terraform/modules/monitoring/alertmanager.tf).
set -eu

SECRETS_DIR=/tmp/alertmanager-secrets

# A missing or empty URL must stop the task here, with a message naming the key, rather than at
# Alertmanager's own config load — which would report "file is empty" against a path that says
# nothing about which secret was not supplied. `set -u` already covers unset; this covers empty,
# which is what a secret key present but blank in Secrets Manager actually looks like.
require() {
  eval "value=\${$1:-}"
  if [ -z "${value}" ]; then
    echo "alertmanager: $1 is unset or empty; supply it in the 'monitoring' app-secrets container" >&2
    exit 1
  fi
}

require ALERTMANAGER_PAGE_URL
require ALERTMANAGER_TICKET_URL
require ALERTMANAGER_HEARTBEAT_URL

mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

# printf '%s', not echo: echo would append a newline, and Alertmanager uses the file's contents
# verbatim as the URL — a trailing newline produces a request to a URL that does not exist, and the
# resulting failure names neither this file nor the newline.
write_secret() {
  printf '%s' "$2" > "${SECRETS_DIR}/$1"
  chmod 600 "${SECRETS_DIR}/$1"
}

write_secret page_url "${ALERTMANAGER_PAGE_URL}"
write_secret ticket_url "${ALERTMANAGER_TICKET_URL}"
write_secret heartbeat_url "${ALERTMANAGER_HEARTBEAT_URL}"

# --cluster.listen-address= (empty) disables the gossip listener. desired_count is 1
# (modules/monitoring/alertmanager.tf) and Fargate gives each task replacement a new address, so
# there is no stable peer list to gossip with; leaving the default on would have every task log
# cluster-settling failures it can never resolve. Revisit together with desired_count if this ever
# needs high availability — see that file's own comment on the trade.
exec /bin/alertmanager \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --web.listen-address=:9093 \
  --web.external-url="${ALERTMANAGER_EXTERNAL_URL:-http://alertmanager.metrics.internal:9093}" \
  --cluster.listen-address=
