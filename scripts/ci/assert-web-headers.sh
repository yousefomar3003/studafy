#!/usr/bin/env bash
# QA-052: every page the web app serves carries the security headers.
#
# nginx only inherits `add_header` into a location that defines none of its own, so the locations
# that set Cache-Control (/index.html, /assets/) used to drop X-Frame-Options, nosniff and
# Referrer-Policy -- and every SPA route is served through /index.html. This runs the production
# nginx image with the real config against a dummy site, and checks the headers on each kind of path.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The runtime stage's own base image, exactly as production builds it (tag and digest).
IMAGE="${WEB_HEADERS_IMAGE:-$(sed -n 's/^FROM \(nginx:[^ ]*\) AS runtime$/\1/p' "$REPO/infra/docker/web.Dockerfile" | head -1)}"
SITE="$(mktemp -d)"
NAME="studafy-web-headers-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$SITE"' EXIT

mkdir -p "$SITE/html/assets" "$SITE/snippets"
printf '<!doctype html><title>t</title>\n' > "$SITE/html/index.html"
printf 'console.log(1)\n' > "$SITE/html/assets/app-abc123.js"
cp "$REPO/infra/docker/web/nginx.conf" "$SITE/default.conf"
if [ -f "$REPO/infra/docker/web/security-headers.conf" ]; then
  cp "$REPO/infra/docker/web/security-headers.conf" "$SITE/snippets/security-headers.conf"
fi

docker run -d --name "$NAME" -p 127.0.0.1::8080 \
  -v "$SITE/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$SITE/snippets:/etc/nginx/snippets:ro" \
  -v "$SITE/html:/usr/share/nginx/html:ro" \
  "$IMAGE" > /dev/null
PORT="$(docker port "$NAME" 8080/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do curl -fs "http://127.0.0.1:$PORT/healthz" > /dev/null && break; sleep 0.5; done

REQUIRED=(
  "x-content-type-options: nosniff"
  "x-frame-options: DENY"
  "referrer-policy: strict-origin-when-cross-origin"
  "strict-transport-security: max-age=31536000; includeSubDomains"
  "permissions-policy:"
  "content-security-policy-report-only:"
)

failed=0
for path in / /portal/some/route /index.html /assets/app-abc123.js; do
  headers="$(curl -fsS -D - -o /dev/null "http://127.0.0.1:$PORT$path" | tr -d '\r' | tr 'A-Z' 'a-z')"
  for header in "${REQUIRED[@]}"; do
    lower="$(printf '%s' "$header" | tr 'A-Z' 'a-z')"
    if ! grep -qF "$lower" <<< "$headers"; then
      echo "MISSING on $path: $header" >&2
      failed=1
    fi
  done
  if ! grep -q "frame-ancestors 'none'" <<< "$headers"; then
    echo "MISSING on $path: CSP frame-ancestors 'none'" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "Web security headers check FAILED" >&2
  exit 1
fi
echo "Web security headers present on /, an SPA route, /index.html and /assets/*."
