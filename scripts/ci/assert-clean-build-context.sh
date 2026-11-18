#!/usr/bin/env bash
# QA-021: prove the root .dockerignore keeps secrets and infrastructure state out of every image's
# build context.
#
# Every infra/docker/*.Dockerfile builds with the repository root as context and runs `COPY . .` in
# its build stage, so anything the .dockerignore lets through is uploaded to the builder (Fly's
# remote builder on a laptop `fly deploy`) and baked into a cached layer.
#
# This never copies a real secret anywhere: it assembles a throwaway context holding only the real
# .dockerignore plus dummy sentinel files at the sensitive paths, lets Docker itself apply the
# ignore rules (COPY . into a scratch image), and asserts what arrived. Control files that builds
# need must arrive; sentinels must not.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_IMAGE="${CONTEXT_CHECK_IMAGE:-oven/bun:1.3.14-alpine}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$REPO/.dockerignore" "$WORK/.dockerignore"

# Must never enter a build context.
SENTINELS=(
  "prod-secrets.json"
  "prod-secerts.json"
  "prod-secrets.staging.json"
  "infra/terraform/terraform.tfstate"
  "infra/terraform/.terraform/terraform.tfstate"
  "infra/terraform/modules/monitoring/lambda/fn.zip"
  "terraform.tfstate.backup"
  ".env"
  ".env.production"
  "apps/api/.env"
  "qa/.tokens.env"
  "apps/mobile/android/app/google-services.json"
  "apps/mobile/ios/Runner/GoogleService-Info.plist"
  "config/service-account-secret.json"
  "keys/server.pem"
  "keys/upload.p12"
  "graphify-out/graph.json"
)
# Must still arrive (builds depend on them).
CONTROLS=(
  "package.json"
  "bun.lock"
  "apps/api/package.json"
  "apps/mobile/package.json"
  "docs/help/getting-started.md"
  "docs/legal/en/privacy.md"
  ".env.example"
  "infra/docker/web/nginx.conf"
)

for path in "${SENTINELS[@]}" "${CONTROLS[@]}"; do
  mkdir -p "$WORK/$(dirname "$path")"
  printf 'qa-021 sentinel, not a real secret\n' > "$WORK/$path"
done

TAG="studafy-context-check:$$"
printf 'FROM %s\nCOPY . /ctx\n' "$BASE_IMAGE" |
  docker build --quiet -t "$TAG" -f - "$WORK" > /dev/null
LISTING="$(docker run --rm --entrypoint sh "$TAG" -c 'cd /ctx && find . -type f | sed "s#^\./##" | sort')"
docker rmi -f "$TAG" > /dev/null

failed=0
for path in "${SENTINELS[@]}"; do
  if grep -qxF "$path" <<< "$LISTING"; then
    echo "LEAK: $path is copied into the build context" >&2
    failed=1
  fi
done
for path in "${CONTROLS[@]}"; do
  if ! grep -qxF "$path" <<< "$LISTING"; then
    echo "MISSING: $path is excluded but builds need it" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "Build context check FAILED (.dockerignore)" >&2
  exit 1
fi
echo "Build context check passed: ${#SENTINELS[@]} sensitive paths excluded, ${#CONTROLS[@]} required paths kept."
