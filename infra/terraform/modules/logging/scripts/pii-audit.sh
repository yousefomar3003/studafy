#!/usr/bin/env bash
# PII audit for the log-aggregation pipeline (ST-261 acceptance criterion: "PII audit script
# sample clean").
#
# Pulls a sample of recently aggregated lines from Loki and scans each for content that should
# never appear in a log line per SAD §28 — email addresses, phone numbers, bearer/JWT tokens,
# AWS keys, private keys, PAN-shaped digit runs (Luhn-checked), inline passwords. Structured
# identifiers that SAD §28 explicitly keeps at the root of the record (request_id, and the
# school_id / user_id UUIDs) are NOT PII and are ignored.
#
# Exit 0 and "sample clean" when nothing matched; exit 1 with a report of the offending lines
# (labels + the redacted match) otherwise. Designed to run from the bastion against an
# SSH-port-forwarded Loki — see docs/runbooks/log-aggregation.md.
#
# Dependencies: bash, curl, jq, grep, awk (all present on the bastion's Amazon Linux image).
set -uo pipefail

LOKI_URL="http://localhost:3100"
SINCE="1h"
LIMIT=5000
QUERY='{env=~".+"}'

usage() {
  cat >&2 <<'EOF'
Usage: pii-audit.sh [--loki-url URL] [--since DURATION] [--limit N] [--query LOGQL]

  --loki-url URL     Base URL of the Loki HTTP API           (default: http://localhost:3100)
  --since DURATION    How far back to sample: 30m, 1h, 24h... (default: 1h)
  --limit N          Max lines to pull and scan              (default: 5000)
  --query LOGQL      Stream selector to sample               (default: {env=~".+"})

Exit status: 0 = sample clean, 1 = PII found (or the query failed), 2 = bad usage.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --loki-url) LOKI_URL="${2:?}"; shift 2 ;;
    --since)    SINCE="${2:?}"; shift 2 ;;
    --limit)    LIMIT="${2:?}"; shift 2 ;;
    --query)    QUERY="${2:?}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

for bin in curl jq grep awk; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 2; }
done

# --- pull the sample -----------------------------------------------------------------------

# Loki wants RFC3339 / unix-nanos. Resolve --since to a start nanotimestamp.
now_ns=$(( $(date -u +%s) * 1000000000 ))
case "$SINCE" in
  *h) secs=$(( ${SINCE%h} * 3600 )) ;;
  *m) secs=$(( ${SINCE%m} * 60 )) ;;
  *s) secs=${SINCE%s} ;;
  *)  echo "unrecognised --since: $SINCE (use e.g. 30m, 1h, 24h)" >&2; exit 2 ;;
esac
start_ns=$(( now_ns - secs * 1000000000 ))

echo "==> sampling up to ${LIMIT} lines from ${LOKI_URL} over the last ${SINCE} (query: ${QUERY})"

resp=$(curl -sS -G "${LOKI_URL}/loki/api/v1/query_range" \
  --data-urlencode "query=${QUERY}" \
  --data-urlencode "start=${start_ns}" \
  --data-urlencode "end=${now_ns}" \
  --data-urlencode "limit=${LIMIT}" \
  --data-urlencode "direction=backward") || {
  echo "query failed — is the port-forward to Loki up?" >&2
  exit 1
}

status=$(printf '%s' "$resp" | jq -r '.status // "error"')
if [ "$status" != "success" ]; then
  echo "Loki returned: $(printf '%s' "$resp" | jq -r '.error // .status // "unknown error"')" >&2
  exit 1
fi

# One TSV row per line: <labels-json>\t<log line>
mapfile -t rows < <(printf '%s' "$resp" \
  | jq -r '.data.result[]? as $s | $s.values[]? | "\($s.stream | tojson)\t\(.[1])"')

count=${#rows[@]}
if [ "$count" -eq 0 ]; then
  echo "no lines in the sample window — widen --since or check the pipeline is delivering." >&2
  exit 1
fi
echo "==> scanning ${count} lines"

# --- detectors ---------------------------------------------------------------------------------

# Each detector is: NAME|ERE. Kept deliberately conservative — a false positive here fails an
# acceptance gate, so patterns require strong shape (a token prefix, a key marker) rather than
# "looks like a number".
detectors=(
  'email|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  'jwt|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  'bearer|[Bb]earer[[:space:]]+[A-Za-z0-9._~+/-]{20,}'
  'aws_access_key|AKIA[0-9A-Z]{16}'
  'aws_secret_in_uri|://[^:@/]+:[A-Za-z0-9/+=]{30,}@'
  'private_key|-----BEGIN[[:space:]]+(RSA[[:space:]]+|EC[[:space:]]+|OPENSSH[[:space:]]+)?PRIVATE[[:space:]]+KEY-----'
  'inline_password|"?pass(word|wd)?"?[[:space:]]*[:=][[:space:]]*"?[^"[:space:],}]{4,}'
  'e164_phone|(^|[^0-9])\+[1-9][0-9]{9,14}([^0-9]|$)'
)

# PAN candidates need a Luhn check to cut the (many) 13-19 digit ids that are not cards.
luhn_ok() {
  awk -v n="$1" 'BEGIN{
    gsub(/[^0-9]/,"",n); if(length(n)<13||length(n)>19){print 1; exit}
    s=0; dbl=0
    for(i=length(n);i>=1;i--){d=substr(n,i,1)+0; if(dbl){d*=2; if(d>9)d-=9}; s+=d; dbl=!dbl}
    print (s%10==0)?0:1
  }'
}

findings=0
report=""

for row in "${rows[@]}"; do
  labels=${row%%$'\t'*}
  line=${row#*$'\t'}

  # Blank out the known-safe structured ids so their UUIDs can never trip a detector.
  scrub=$(printf '%s' "$line" | sed -E \
    -e 's/"request_id":"[^"]*"/"request_id":"<id>"/g' \
    -e 's/"(school_id|user_id)":"[0-9a-fA-F-]{36}"/"\1":"<uuid>"/g')

  for det in "${detectors[@]}"; do
    name=${det%%|*}
    ere=${det#*|}
    match=$(printf '%s' "$scrub" | grep -oiE "$ere" | head -n1 || true)
    [ -n "$match" ] || continue

    findings=$((findings + 1))
    redacted=$(printf '%s' "$match" | sed -E 's/.{4}$/****/')
    report+="  [${name}] labels=${labels} match=${redacted}"$'\n'
    break
  done

  # PAN scan, separate because of the Luhn gate.
  for cand in $(printf '%s' "$scrub" | grep -oE '(^|[^0-9])[0-9]([ -]?[0-9]){12,18}([^0-9]|$)' | tr -cd '0-9 \n'); do
    [ -n "$cand" ] || continue
    if [ "$(luhn_ok "$cand")" = "0" ]; then
      findings=$((findings + 1))
      report+="  [pan] labels=${labels} match=$(printf '%s' "$cand" | sed -E 's/[0-9]/#/g; s/#{4}$/####/')"$'\n'
      break
    fi
  done
done

echo
if [ "$findings" -eq 0 ]; then
  echo "PII audit: sample clean (${count} lines, 0 findings)."
  exit 0
fi

echo "PII audit: ${findings} suspected leak(s) in ${count} sampled lines:" >&2
printf '%s' "$report" >&2
echo >&2
echo "Investigate the emitting call site (SAD §28: never interpolate an unstringified dynamic" >&2
echo "value into a line; the log line is the operator's copy, the response body is the client's)." >&2
exit 1
