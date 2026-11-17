#!/usr/bin/env bash
# QA-005: build once, scan, deploy by digest, smoke, roll back.
#
#   release.sh current-image <app>                      print the image the app runs now (or "")
#   release.sh build <app> <config> <label> [args...]   remote-build and push, print the digest ref
#   release.sh deploy <app> <config> <image> [args...]  deploy exactly that image
#   release.sh smoke <api base url> <web base url>      readiness + auth surface + shared JWT key
#
# FLYCTL, DOCKER and CURL override the binaries (tests). The digest is resolved from the registry,
# so the image Trivy scans is byte-for-byte the image that is deployed.
set -euo pipefail

flyctl_bin="${FLYCTL:-flyctl}"
docker_bin="${DOCKER:-docker}"
curl_bin="${CURL:-curl}"

current_image() {
  local app="$1"
  "$flyctl_bin" image show --app "$app" --json 2>/dev/null |
    jq -r '(if type == "array" then .[0] else . end) as $i
           | if ($i.Digest // $i.digest // "") != "" then
               "\($i.Registry // $i.registry)/\($i.Repository // $i.repository)@\($i.Digest // $i.digest)"
             else "" end' 2>/dev/null || true
}

build() {
  local app="$1" config="$2" label="$3"
  shift 3
  "$flyctl_bin" deploy . --config "$config" --app "$app" --remote-only --build-only --push \
    --image-label "$label" "$@" >&2
  local tag="registry.fly.io/$app:$label"
  local digest
  digest="$("$docker_bin" buildx imagetools inspect "$tag" --format '{{json .Manifest}}' | jq -r '.digest')"
  if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::Could not resolve a digest for $tag (got '$digest')." >&2
    return 1
  fi
  echo "registry.fly.io/$app@$digest"
}

deploy() {
  local app="$1" config="$2" image="$3"
  shift 3
  if ! [[ "$image" == *@sha256:* ]]; then
    echo "::error::Refusing to deploy $app from a mutable reference: $image" >&2
    return 1
  fi
  "$flyctl_bin" deploy --config "$config" --app "$app" --image "$image" "$@"
}

fetch() {
  "$curl_bin" --silent --show-error --max-time 10 --output "${2:-/dev/null}" --write-out '%{http_code}' "$1" || echo 000
}

smoke() {
  local api="$1" web="$2" code attempt
  for attempt in $(seq 1 "${SMOKE_ATTEMPTS:-10}"); do
    code="$(fetch "$api/readyz")"
    [ "$code" = 200 ] && break
    echo "readyz answered $code (attempt $attempt)" >&2
    sleep "${SMOKE_DELAY:-6}"
  done
  [ "$code" = 200 ] || { echo "::error::$api/readyz never became ready (last $code)." >&2; return 1; }

  code="$(fetch "$web/healthz")"
  [ "$code" = 200 ] || { echo "::error::$web/healthz answered $code." >&2; return 1; }

  # The auth surface answers, and refuses an anonymous caller rather than erroring.
  code="$(fetch "$api/api/auth/sessions")"
  [ "$code" = 401 ] || { echo "::error::anonymous /api/auth/sessions answered $code, expected 401." >&2; return 1; }

  # Every machine signs with the same key (QA-023): repeated JWKS reads agree on one kid set.
  local tmp kids="" seen
  tmp="$(mktemp)"
  for _ in 1 2 3 4 5; do
    code="$(fetch "$api/.well-known/jwks.json" "$tmp")"
    [ "$code" = 200 ] || { echo "::error::JWKS answered $code." >&2; rm -f "$tmp"; return 1; }
    seen="$(jq -r '[.keys[].kid] | sort | join(",")' "$tmp")"
    [ -n "$seen" ] || { echo "::error::JWKS published no keys." >&2; rm -f "$tmp"; return 1; }
    if [ -n "$kids" ] && [ "$seen" != "$kids" ]; then
      echo "::error::JWKS differs between reads ($kids vs $seen): machines are not sharing JWT_PRIVATE_KEY_PEM." >&2
      rm -f "$tmp"
      return 1
    fi
    kids="$seen"
  done
  rm -f "$tmp"
  echo "smoke ok: readyz, web, auth surface, JWKS kid(s) $kids"
}

command="${1:-}"
shift || true
case "$command" in
  current-image) current_image "$@" ;;
  build) build "$@" ;;
  deploy) deploy "$@" ;;
  smoke) smoke "$@" ;;
  *)
    echo "usage: release.sh current-image|build|deploy|smoke ..." >&2
    exit 2
    ;;
esac
