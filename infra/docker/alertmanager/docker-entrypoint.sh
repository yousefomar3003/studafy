#!/bin/sh
# Renders alertmanager.yml's __PLACEHOLDER__ tokens — the SNS region and the three receivers' topic
# ARNs — from the environment, then starts Alertmanager on the rendered copy.
#
# sed rather than envsubst (which is how infra/docker/loki/docker-entrypoint.sh handles *its*
# per-environment values): the upstream prom/alertmanager image is busybox-based and has no package
# manager, so there is no envsubst to install — the same constraint infra/docker/prometheus.Docker
# file already notes. busybox does ship sed.
#
# The env vars come from the ECS task definition's `environment` block
# (infra/terraform/modules/monitoring/alertmanager.tf). None of them is a secret: publishing is
# authorised by the task role and the topic policies, not by knowing an ARN.
set -eu

RENDERED_CONFIG=/tmp/alertmanager.yml

# A missing value must stop the task here, with a message naming the variable, rather than as an
# SNS publish error on the first real page — which is the worst possible moment to find out.
require() {
  eval "value=\${$1:-}"
  if [ -z "${value}" ]; then
    echo "alertmanager: $1 is unset or empty; it is set by modules/monitoring/alertmanager.tf" >&2
    exit 1
  fi
}

require ALERTMANAGER_SNS_REGION
require ALERTMANAGER_PAGE_TOPIC_ARN
require ALERTMANAGER_TICKET_TOPIC_ARN
require ALERTMANAGER_HEARTBEAT_TOPIC_ARN

# `|` as the delimiter: ARNs are full of `:` and never contain `|`.
sed \
  -e "s|__SNS_REGION__|${ALERTMANAGER_SNS_REGION}|g" \
  -e "s|__PAGE_TOPIC_ARN__|${ALERTMANAGER_PAGE_TOPIC_ARN}|g" \
  -e "s|__TICKET_TOPIC_ARN__|${ALERTMANAGER_TICKET_TOPIC_ARN}|g" \
  -e "s|__HEARTBEAT_TOPIC_ARN__|${ALERTMANAGER_HEARTBEAT_TOPIC_ARN}|g" \
  /etc/alertmanager/alertmanager.yml > "${RENDERED_CONFIG}"

# --cluster.listen-address= (empty) disables the gossip listener. desired_count is 1
# (modules/monitoring/alertmanager.tf) and Fargate gives each task replacement a new address, so
# there is no stable peer list to gossip with; leaving the default on would have every task log
# cluster-settling failures it can never resolve. Revisit together with desired_count if this ever
# needs high availability — see that file's own comment on the trade.
exec /bin/alertmanager \
  --config.file="${RENDERED_CONFIG}" \
  --storage.path=/alertmanager \
  --web.listen-address=:9093 \
  --web.external-url="${ALERTMANAGER_EXTERNAL_URL:-http://alertmanager.metrics.internal:9093}" \
  --cluster.listen-address=
