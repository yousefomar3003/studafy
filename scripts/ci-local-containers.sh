#!/usr/bin/env bash
# Mirrors the "build-scan" matrix in .github/workflows/containers.yml: builds each service image,
# enforces its size budget, and runs a Trivy scan if Trivy is installed locally. Skips erpnext by
# default (its base image is ~2.7GB); set INCLUDE_ERPNEXT=1 to include it.
set -uo pipefail

# "service:size-budget-MB" pairs, same budgets as containers.yml. Plain arrays rather than
# associative ones so this runs on macOS's stock bash 3.2.
SERVICES=(api:150 realtime:200 workers:250 migrations:100 web:120)
if [ "${INCLUDE_ERPNEXT:-0}" = "1" ]; then
  SERVICES+=(erpnext:3072)
fi

fail=0
for entry in "${SERVICES[@]}"; do
  service="${entry%%:*}"
  budget_mb="${entry##*:}"
  dockerfile="infra/docker/$service.Dockerfile"
  echo "==> building $service ($dockerfile)"
  if ! docker build -f "$dockerfile" -t "studafy/$service:ci-local" .; then
    echo "$service failed to build" >&2
    fail=1
    continue
  fi

  bytes=$(docker image inspect "studafy/$service:ci-local" --format '{{.Size}}')
  max=$((budget_mb * 1024 * 1024))
  echo "image size: $((bytes / 1024 / 1024))MB ($bytes bytes) -- budget: ${budget_mb}MB"
  if [ "$bytes" -gt "$max" ]; then
    echo "$service exceeds its image size budget" >&2
    fail=1
  fi

  if command -v trivy >/dev/null 2>&1; then
    trivy image --severity CRITICAL --ignore-unfixed --exit-code 1 --ignorefile .trivyignore "studafy/$service:ci-local" || fail=1
  else
    echo "trivy not installed locally; skipping vulnerability scan for $service (CI still runs it)"
  fi
done

exit $fail
