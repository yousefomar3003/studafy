#!/usr/bin/env bash
# Creates the Axiom side of the alert catalog (docs/runbooks/alerts.md): one Telegram notifier and
# the Axiom monitors A3, A4, A5, A9, A10 and A11 on dataset studafy-logs.
#
# Safe to re-run: a notifier or monitor that already exists under the same name is left alone.
#
# Needs (asked for interactively when not set, so they stay out of shell history):
#   AXIOM_TOKEN         Axiom API token that can create and read monitors and notifiers
#   TELEGRAM_BOT_TOKEN  the bot that posts the alerts (from @BotFather)
#   TELEGRAM_CHAT_ID    the chat or group it posts to
#
# Log shape this relies on (infra/fly/log-shipper.toml): Fly's log shipper sends each event with the
# service's own JSON line as a *string* in `message`, and the app name in `fly.app.name`. So every
# query parses `message` first. The workers write `level` as a word ("error") while the API writes
# pino numbers (50), so the error filter accepts both.
set -euo pipefail

API="https://api.axiom.co/v2"
DATASET="studafy-logs"
NOTIFIER_NAME="Studafy Telegram"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

[[ -n "${AXIOM_TOKEN:-}" ]] || { read -rsp "Axiom API token: " AXIOM_TOKEN; echo; }
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] || { read -rsp "Telegram bot token: " TELEGRAM_BOT_TOKEN; echo; }
[[ -n "${TELEGRAM_CHAT_ID:-}" ]] || { read -rp "Telegram chat id: " TELEGRAM_CHAT_ID; }

axiom() { # method path [json-body]
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" "$API$path" -H "Authorization: Bearer $AXIOM_TOKEN" -H "Content-Type: application/json" -w $'\n%{http_code}')
  [[ -n "$body" ]] && args+=(--data "$body")
  local out code
  out=$(curl "${args[@]}")
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [[ "$code" != 2* ]]; then
    echo "Axiom $method $path failed ($code): $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

# --- 1. Check the bot can post to the chat before wiring anything to it ------------------------
tg_check=$(curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=Studafy: connecting Axiom alerts to this chat.")
if [[ "$(jq -r '.ok' <<<"$tg_check")" != "true" ]]; then
  echo "Telegram refused the test message: $(jq -r '.description // .' <<<"$tg_check")" >&2
  exit 1
fi
echo "Telegram test message sent."

# --- 2. Notifier --------------------------------------------------------------------------------
notifier_id=$(axiom GET /notifiers | jq -r --arg n "$NOTIFIER_NAME" '.[] | select(.name == $n) | .id' | head -n1)
if [[ -z "$notifier_id" ]]; then
  # Go template, rendered by Axiom per notification. jsonString quotes the whole text, so a monitor
  # body with quotes or newlines cannot break the JSON Telegram receives.
  template=$(jq -nc --arg chat "$TELEGRAM_CHAT_ID" \
    '"{\"chat_id\": \($chat | tojson), \"disable_web_page_preview\": true, \"text\": {{jsonString (printf \"%s: %s\\n%s\\n%s\" .Action .Name .Body .MonitorURL)}}}"')
  notifier=$(jq -nc --arg name "$NOTIFIER_NAME" \
    --arg url "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --argjson body "$template" \
    '{name: $name, properties: {customWebhook: {url: $url, headers: {"Content-Type": "application/json"}, body: $body}}}')
  notifier_id=$(axiom POST /notifiers "$notifier" | jq -r '.id')
  echo "Created notifier \"$NOTIFIER_NAME\" ($notifier_id)."
else
  echo "Notifier \"$NOTIFIER_NAME\" already exists ($notifier_id)."
fi

# --- 3. Monitors --------------------------------------------------------------------------------
BASE="['$DATASET']
| where ['fly.app.name'] startswith 'studafy-core-'
| extend line = parse_json(message)
| extend lvl = tostring(line.level), msg = tostring(line.msg)"
ERRORS="| where lvl in ('error', 'fatal', '50', '60')"

existing=$(axiom GET /monitors | jq -c '[.[].name]')

# name description operator threshold interval range alertOnNoData notifyByGroup query
monitor() {
  local name=$1 description=$2 operator=$3 threshold=$4 interval=$5 range=$6 no_data=$7 by_group=$8 query=$9
  if jq -e --arg n "$name" 'index($n) != null' <<<"$existing" >/dev/null; then
    echo "Monitor \"$name\" already exists, left as is."
    return
  fi
  local body
  body=$(jq -nc --arg name "$name" --arg description "$description" --arg operator "$operator" \
    --argjson threshold "$threshold" --argjson interval "$interval" --argjson range "$range" \
    --argjson no_data "$no_data" --argjson by_group "$by_group" --arg query "$query" --arg notifier "$notifier_id" \
    '{name: $name, description: $description, type: "Threshold", operator: $operator, threshold: $threshold,
      intervalMinutes: $interval, rangeMinutes: $range, alertOnNoData: $no_data, notifyByGroup: $by_group,
      resolvable: true, aplQuery: $query, notifierIds: [$notifier]}')
  axiom POST /monitors "$body" >/dev/null
  echo "Created monitor \"$name\"."
}

monitor "[CRITICAL] A3 Workers heartbeat missing" \
  "No 'workers heartbeat' line in 5 minutes: the workers app is down or stuck. Runbook: docs/runbooks/alerts.md" \
  Below 1 5 5 true false \
  "$BASE
| where ['fly.app.name'] == 'studafy-core-workers' and msg == 'workers heartbeat'
| summarize count()"

monitor "[CRITICAL] A4 Workers unhealthy" \
  "The workers report a stopped poll loop or BullMQ worker. Runbook: docs/runbooks/alerts.md" \
  Above 0 5 5 false false \
  "$BASE
| where msg == 'workers heartbeat: unhealthy'
| summarize count()"

monitor "[WARNING] A5 Error-log spike" \
  "More than 20 error lines from one service in 5 minutes. Runbook: docs/runbooks/alerts.md" \
  Above 20 5 5 false true \
  "$BASE
$ERRORS
| summarize count() by app = ['fly.app.name']"

monitor "[CRITICAL] A9 Billing failures" \
  "An invoice, dunning or renewal step logged an error. Runbook: docs/runbooks/alerts.md" \
  Above 0 5 15 false false \
  "$BASE
$ERRORS
| where msg contains 'invoice' or msg contains 'dunning' or msg contains 'renewal'
| summarize count()"

monitor "[WARNING] A10 Scan failures" \
  "More than 5 file-scan errors in 15 minutes. Runbook: docs/runbooks/alerts.md" \
  Above 5 5 15 false false \
  "$BASE
$ERRORS
| where msg contains 'scan'
| summarize count()"

monitor "[CRITICAL] A11 Payment disputed" \
  "A payment was disputed: look at the charge (customer_id is in the log line). Runbook: docs/runbooks/alerts.md" \
  Above 0 5 15 false false \
  "$BASE
| where tostring(line.alert) == 'billing_alert'
| summarize count()"

echo "Done. Open Axiom > Monitors to see them, then run the fire drills in docs/runbooks/alerts.md."
