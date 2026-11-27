#!/usr/bin/env bash
# QA-005: build once, scan, deploy by digest, smoke, roll back.
#
#   release.sh current-image <app>                      print the image the app runs now (or "")
#   release.sh build <app> <config> <label> [args...]   remote-build and push, print the digest ref
#   release.sh deploy <app> <config> <image> [args...]  deploy exactly that image
#   release.sh smoke <api base url> <web base url>      readiness + auth surface + shared JWT key
#   release.sh private-only <app>                       the app has a private address and no public one
#   release.sh smoke-private <app> <url>                <url> answers from inside the app's machine
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
  local digest="" attempt
  # The Fly registry can answer "not found" for a few seconds after the push completes, so look
  # the tag up again before giving up.
  for attempt in $(seq 1 "${DIGEST_ATTEMPTS:-10}"); do
    digest="$("$docker_bin" buildx imagetools inspect "$tag" --format '{{json .Manifest}}' |
      jq -r '.digest' 2>/dev/null || true)"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] && break
    echo "No digest for $tag yet (attempt $attempt); retrying." >&2
    sleep "${DIGEST_RETRY_DELAY:-6}"
  done
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

# A private app (ERPNext) is reached over its Flycast address only. `fly deploy` allocates public
# addresses to an app that has none, so this runs before its deploy as well as after.
private_only() {
  local app="$1" ips public private
  ips="$("$flyctl_bin" ips list --app "$app" --json)" || {
    echo "::error::Could not list the IP addresses of $app." >&2
    return 1
  }
  public="$(jq -r '[(. // [])[] | select(((.Type // .type // "") | ascii_downcase | test("private")) | not)
                    | (.Address // .address // "?")] | join(" ")' <<<"$ips")"
  private="$(jq -r '[(. // [])[] | select((.Type // .type // "") | ascii_downcase | test("private"))] | length' <<<"$ips")"
  if [ -n "$public" ]; then
    echo "::error::$app has public addresses ($public). Release each: fly ips release <address> --app $app" >&2
    return 1
  fi
  if [ "$private" = 0 ]; then
    echo "::error::$app has no private address. Allocate one: fly ips allocate-v6 --private --app $app" >&2
    return 1
  fi
  echo "$app: private address only"
}

# Nothing outside the organisation's network reaches a private app, so its URL is fetched from inside
# its started machine. Any status below 500 passes: Frappe answers 404 when no site matches the Host.
smoke_private() {
  local app="$1" url="$2" attempt id out="" code=""
  for attempt in $(seq 1 "${SMOKE_ATTEMPTS:-30}"); do
    id="$("$flyctl_bin" machine list --app "$app" --json 2>/dev/null |
      jq -r '[.[]? | select(.state == "started") | .id][0] // ""' 2>/dev/null || true)"
    if [ -n "$id" ]; then
      out="$("$flyctl_bin" machine exec "$id" \
        "curl --silent --output /dev/null --max-time 10 --write-out smoke-status-%{http_code} $url" \
        --app "$app" 2>&1 || true)"
      code="$(grep -o 'smoke-status-[0-9]\{3\}' <<<"$out" | tail -n 1 | cut -d- -f3 || true)"
      if [ -n "$code" ] && [ "$code" != 000 ] && [ "$code" -lt 500 ]; then
        echo "smoke ok: $app answers $url with $code"
        return 0
      fi
    fi
    echo "$app does not answer $url yet (attempt $attempt, status ${code:-none})" >&2
    sleep "${SMOKE_DELAY:-10}"
  done
  echo "::error::$app never answered $url from inside its machine. Last output: ${out:-none}" >&2
  return 1
}

command="${1:-}"
shift || true
case "$command" in
  current-image) current_image "$@" ;;
  build) build "$@" ;;
  deploy) deploy "$@" ;;
  smoke) smoke "$@" ;;
  private-only) private_only "$@" ;;
  smoke-private) smoke_private "$@" ;;
  *)
    echo "usage: release.sh current-image|build|deploy|smoke|private-only|smoke-private ..." >&2
    exit 2
    ;;
esac
