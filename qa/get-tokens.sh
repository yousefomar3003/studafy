#!/usr/bin/env bash
# Signs in as every QA account (qa/accounts.json) through POST /api/auth/login/qa and writes the
# access tokens to qa/.tokens.env (gitignored, mode 600) as `export QA_TOKEN_<SCHOOL>_<ROLE>=...`.
# QA-02; see docs/runbooks/qa-staging-access.md.
#
#   QA_LOGIN_PASSWORD=... qa/get-tokens.sh            # staging (default)
#   QA_BASE_URL=http://localhost:3000 qa/get-tokens.sh
#   QA_CHANNEL=mobile qa/get-tokens.sh                # force one channel for every account
#   source qa/.tokens.env && curl -H "authorization: Bearer $QA_TOKEN_A_ORG_ADMIN" ...
#
# Needs curl and jq. Prompts for the password when QA_LOGIN_PASSWORD is unset. The password reaches
# curl through stdin, never argv, so it does not show up in `ps`. Access tokens live 15 minutes; run
# again to refresh them. A 429 is waited out (Retry-After) rather than failed.
#
# Each account signs in on the channel its role needs (accounts.json `channel`): `mobile` for
# students, parents, teachers and attendance officers, who get no web session, and `web` for staff
# and platform roles, whose admin routes refuse any other channel. A web login still returns the
# access token in the body; only the refresh token goes to a cookie, which this script does not keep.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BASE_URL="${QA_BASE_URL:-https://staging-api.studafy.com}"
OUT_FILE="${QA_TOKENS_FILE:-$PWD/.tokens.env}"
MAX_ATTEMPTS=6

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "get-tokens: $tool is required" >&2; exit 1; }
done

if [[ -z "${QA_LOGIN_PASSWORD:-}" ]]; then
  read -r -s -p "QA password: " QA_LOGIN_PASSWORD
  echo >&2
fi
export QA_LOGIN_PASSWORD

umask 077
tmp_out="$(mktemp)"
headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$tmp_out" "$headers" "$body"' EXIT
echo "# QA tokens from $BASE_URL at $(date -u +%Y-%m-%dT%H:%M:%SZ). Valid ~15 minutes." >"$tmp_out"

failures=0
while IFS=$'\t' read -r email variable school role account_channel; do
  channel="${QA_CHANNEL:-$account_channel}"
  status=""
  for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
    : >"$body"
    status="$(
      jq -n --arg email "$email" --arg channel "$channel" \
        '{email: $email, password: env.QA_LOGIN_PASSWORD, channel: $channel}' |
        curl -sS -o "$body" -D "$headers" -w '%{http_code}' \
          -H 'content-type: application/json' --data-binary @- \
          "$BASE_URL/api/auth/login/qa"
    )" || status=000
    [[ "$status" == 429 ]] || break
    wait_s="$(awk 'tolower($1) == "retry-after:" { print $2 + 0 }' "$headers" | tail -1)"
    sleep "${wait_s:-10}"
  done

  if [[ "$status" == 200 ]]; then
    printf 'export %s=%s\n' "$variable" "$(jq -r .access_token "$body")" >>"$tmp_out"
    printf '  ok    %-9s %-19s %-7s %s\n' "$school" "$role" "$channel" "$email"
  else
    failures=$((failures + 1))
    detail="$(jq -r '.code // .detail // empty' "$body" 2>/dev/null || true)"
    printf '  FAIL  %-9s %-19s %s  (HTTP %s %s)\n' "$school" "$role" "$email" "$status" "$detail" >&2
  fi
done < <(jq -r '.[] | [.email, .token_variable, .school, .role, .channel] | @tsv' accounts.json)

mv "$tmp_out" "$OUT_FILE"
echo "Wrote $(grep -c '^export' "$OUT_FILE") tokens to $OUT_FILE. Load them with: source $OUT_FILE"
if ((failures > 0)); then
  echo "$failures account(s) failed: 401 = wrong password or tenant not seeded, 404 = QA_LOGIN_PASSWORD unset on the API." >&2
  exit 1
fi
