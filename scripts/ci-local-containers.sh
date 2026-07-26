#!/usr/bin/env bash
# Mirrors the "build-scan" matrix in .github/workflows/containers.yml: builds each service image,
# enforces its size budget, and runs a Trivy scan if Trivy is installed locally. Skips erpnext by
# default (its base image is ~2.7GB); set INCLUDE_ERPNEXT=1 to include it.
set -uo pipefail

declare -A DOCKERFILES=(
  [api]=infra/docker/api.Dockerfile
  [realtime]=infra/docker/realtime.Dockerfile
  [workers]=infra/docker/workers.Dockerfile
  [migrations]=infra/docker/migrations.Dockerfile
  [web]=infra/docker/web.Dockerfile
)
declare -A MAX_MB=(
  [api]=150
  [realtime]=200
  [workers]=250
  [migrations]=100
  [web]=120
)

if [ "${INCLUDE_ERPNEXT:-0}" = "1" ]; then
  DOCKERFILES[erpnext]=infra/docker/erpnext.Dockerfile
  MAX_MB[erpnext]=3072
fi

fail=0
for service in "${!DOCKERFILES[@]}"; do
  dockerfile="${DOCKERFILES[$service]}"
  echo "==> building $service ($dockerfile)"
  if ! docker build -f "$dockerfile" -t "studafy/$service:ci-local" .; then
    echo "$service failed to build" >&2
    fail=1
    continue
  fi

  bytes=$(docker image inspect "studafy/$service:ci-local" --format '{{.Size}}')
  max=$(( MAX_MB[$service] * 1024 * 1024 ))
  echo "image size: $((bytes / 1024 / 1024))MB ($bytes bytes) -- budget: ${MAX_MB[$service]}MB"
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
