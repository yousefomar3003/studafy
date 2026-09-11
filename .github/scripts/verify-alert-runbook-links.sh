#!/usr/bin/env bash
# verify-alert-runbook-links.sh
#
# CI check for the runbook-library acceptance criterion: "Every alert rule links to
# an existing runbook."
#
# For each CloudWatch alarm in infra/terraform/modules/monitoring/main.tf, search
# docs/runbooks/**/*.md (recursively) for either the alarm's Terraform resource name
# (e.g. `rds_cpu`) or a set of semantic terms for the failure it fires on. An alarm
# with zero matches fails the build.
#
# Mapping an alarm to a runbook is a documentation act, not a search artifact: when a
# runbook documents what a person does on this alarm, it cites the alarm name or its
# metric/namespace verbatim. Adding a runbook without that citation — or adding an
# alarm without a runbook that names it — fails here on purpose.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF_FILE="$REPO_ROOT/infra/terraform/modules/monitoring/main.tf"
RUNBOOK_DIR="$REPO_ROOT/docs/runbooks"

if [ ! -f "$TF_FILE" ]; then
  echo "::error::Terraform monitoring module not found: $TF_FILE"
  exit 1
fi
if [ ! -d "$RUNBOOK_DIR" ]; then
  echo "::error::Runbook directory not found: $RUNBOOK_DIR"
  exit 1
fi

# Semantic terms per alarm. Each alarm is also searched by its own resource name, so
# these terms only need to be a reasonable content anchor, not an exhaustive index.
declare -A SEARCH_TERMS
SEARCH_TERMS[rds_cpu]='rds_cpu|CPUUtilization|RDS.*CPU|database.*CPU'
SEARCH_TERMS[postgres_replica_lag]='postgres_replica_lag|postgres_replica|ReplicaLag|replica lag|replica-lag'
SEARCH_TERMS[postgres_storage]='postgres_storage|FreeStorageSpace|storage.*low|low.*storage'
SEARCH_TERMS[redis_cpu]='redis_cpu|EngineCPUUtilization|redis.*engine.*cpu|ElastiCache.*CPU'
SEARCH_TERMS[ecs_cpu]='ecs_cpu|CPUUtilization|ECS.*CPU|ecs.*cpu'
SEARCH_TERMS[realtime_probe_latency]='realtime_probe_latency|RealtimeProbeLatency|realtime probe|realtime-probe|probe latency'

# WARN if an alarm appears in main.tf that this script has no terms for — a new alarm
# must be added here (and get a runbook) rather than silently passing.
EXPECTED_ALARMS='rds_cpu postgres_replica_lag postgres_storage redis_cpu ecs_cpu realtime_probe_latency'

# Extract {resource-label} and {alarm_description} per alarm. This is a grep of the
# TF file's structure, sufficient because alarm blocks are regular:
#   resource "aws_cloudwatch_metric_alarm" "<label>" { ... alarm_description = "..."
# A label is "known" the moment a description follows it (descriptions are mandatory),
# so scanning for description lines while tracking the last-seen label is enough.
parse_alarms() {
  local line label desc
  label=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*resource[[:space:]]+\"aws_cloudwatch_metric_alarm\"[[:space:]]+\"([a-zA-Z_]+)\" ]]; then
      label="${BASH_REMATCH[1]}"
    fi
    if [[ -n "$label" && "$line" =~ alarm_description[[:space:]]*=[[:space:]]*\"(.*)\"[[:space:]]*$ ]]; then
      printf '%s\t%s\n' "$label" "${BASH_REMATCH[1]}"
      label=""
    fi
  done < "$TF_FILE"
}

mapfile -t ALARMS < <(parse_alarms)

if [ "${#ALARMS[@]}" -eq 0 ]; then
  echo "::error::No CloudWatch alarms parsed from $TF_FILE — did the module structure change?"
  exit 1
fi

echo "Found ${#ALARMS[@]} CloudWatch alarm(s) in infra/terraform/modules/monitoring/main.tf"
echo ""

missing=0
unknown=0

for entry in "${ALARMS[@]}"; do
  label="${entry%%$'\t'*}"
  description="${entry#*$'\t'}"

  if ! grep -qE "([[:space:]]|^)$label([[:space:]]|$)" <<<"$EXPECTED_ALARMS"; then
    echo "::warning::Alarm '$label' is not mapped in verify-alert-runbook-links.sh (no search terms)."
    echo "  If it is a real alarm, add it to EXPECTED_ALARMS + SEARCH_TERMS and link a runbook."
    echo ""
    unknown=$((unknown + 1))
    continue
  fi

  terms="${SEARCH_TERMS[$label]}"
  # Alarm's own name + governing terms; search the whole runbook tree, case-insensitive.
  pattern="($label|$terms)"

  matched="$(grep -rilE "$pattern" "$RUNBOOK_DIR" 2>/dev/null | sed "s|$REPO_ROOT/||; s|^|  - |")"

  if [ -z "$matched" ]; then
    echo "::error::Alarm '$label' has no linked runbook."
    echo "  Description in Terraform: $description"
    echo "  Expected: a file under docs/runbooks/ that documents this failure and cites '$label' or a term in: $terms"
    echo ""
    missing=$((missing + 1))
  else
    echo "OK $label — $description"
    echo "$matched"
    echo ""
  fi
done

if [ "$unknown" -gt 0 ]; then
  echo "::warning::$unknown alarm(s) not covered by SEARCH_TERMS (warnings above are not fatal; they are a TODO)."
  echo ""
fi

if [ "$missing" -gt 0 ]; then
  echo "::error::$missing alarm(s) have no linked runbook. Every CloudWatch alarm must link to an existing runbook."
  exit 1
fi

echo "All ${#ALARMS[@]} CloudWatch alarm(s) are linked to at least one runbook."