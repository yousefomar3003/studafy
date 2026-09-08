#!/usr/bin/env bash
# request_id trace for the log-aggregation pipeline (ST-261 acceptance criterion: "request_id
# search returns cross-service correlated lines").
#
# Given a request_id, pulls every aggregated line carrying it — across api, realtime, workers and
# anything else shipping to Loki — and prints them in time order, one per row, tagged with the
# emitting service. This is the cross-service correlation the acceptance criterion asks for; it is
# also exactly what Grafana Explore runs behind `{env=~".+"} | json | request_id="<id>"`.
#
# Run from the bastion against an SSH-port-forwarded Loki — see docs/runbooks/log-aggregation.md.
# Dependencies: bash, curl, jq.
set -uo pipefail

LOKI_URL="http://localhost:3100"
SINCE="24h"
LIMIT=5000

usage() {
  cat >&2 <<'EOF'
Usage: trace-request.sh [--loki-url URL] [--since DURATION] [--limit N] <request_id>

  --loki-url URL     Base URL of the Loki HTTP API           (default: http://localhost:3100)
  --since DURATION    How far back to search: 1h, 24h, 168h  (default: 24h)
  --limit N          Max lines to return                     (default: 5000)

Exit status: 0 = one or more lines found, 1 = none found / query failed, 2 = bad usage.
EOF
}

REQUEST_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --loki-url) LOKI_URL="${2:?}"; shift 2 ;;
    --since)    SINCE="${2:?}"; shift 2 ;;
    --limit)    LIMIT="${2:?}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         echo "unknown argument: $1" >&2; usage; exit 2 ;;
    *)          REQUEST_ID="$1"; shift ;;
  esac
done

[ -n "$REQUEST_ID" ] || { echo "a request_id is required" >&2; usage; exit 2; }
for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 2; }
done

now_ns=$(( $(date -u +%s) * 1000000000 ))
case "$SINCE" in
  *h) secs=$(( ${SINCE%h} * 3600 )) ;;
  *m) secs=$(( ${SINCE%m} * 60 )) ;;
  *)  echo "unrecognised --since: $SINCE (use e.g. 1h, 24h, 168h)" >&2; exit 2 ;;
esac
start_ns=$(( now_ns - secs * 1000000000 ))

# Filter on the raw substring first (cheap, server-side) then parse+match the field exactly, so a
# value that happens to appear elsewhere in a line cannot produce a false hit.
query="{env=~\".+\"} |= \`${REQUEST_ID}\` | json | request_id=\`${REQUEST_ID}\`"

resp=$(curl -sS -G "${LOKI_URL}/loki/api/v1/query_range" \
  --data-urlencode "query=${query}" \
  --data-urlencode "start=${start_ns}" \
  --data-urlencode "end=${now_ns}" \
  --data-urlencode "limit=${LIMIT}" \
  --data-urlencode "direction=forward") || {
  echo "query failed — is the port-forward to Loki up?" >&2
  exit 1
}

[ "$(printf '%s' "$resp" | jq -r '.status // "error"')" = "success" ] || {
  echo "Loki returned: $(printf '%s' "$resp" | jq -r '.error // .status')" >&2
  exit 1
}

lines=$(printf '%s' "$resp" | jq -r '
  [ .data.result[]? as $s
    | $s.values[]?
    | { ns: (.[0] | tonumber),
        svc: ($s.stream.service // "?"),
        line: .[1] } ]
  | sort_by(.ns)
  | .[]
  | "\((.ns/1000000000) | strftime("%Y-%m-%dT%H:%M:%SZ"))  \(.svc | . + (" " * (9 - (. | length))))  \(.line)"
')

if [ -z "$lines" ]; then
  echo "no lines found for request_id=${REQUEST_ID} in the last ${SINCE}." >&2
  echo "(the pipeline has a ~1-2 min stdout-to-Loki delay — retry if the request is very recent.)" >&2
  exit 1
fi

n=$(printf '%s\n' "$lines" | grep -c '')
echo "==> ${n} line(s) for request_id=${REQUEST_ID}, time-ordered, across $(printf '%s\n' "$lines" | awk '{print $2}' | sort -u | paste -sd, -):"
echo
printf '%s\n' "$lines"
