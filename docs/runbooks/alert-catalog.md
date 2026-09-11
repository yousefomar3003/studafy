# Alert catalog and severity matrix (ST-262)

Every alert this system can raise, what it means, and what to do about it.

This file is not only documentation: `scripts/check-alert-rules.ts` runs in CI and fails the build
if any alert rule links a `runbook_url` whose `###` section is missing here, if any alert carries a
severity outside the matrix below, or if a section here is linked by no alert. The catalog and the
rules cannot drift apart without CI saying so.

- **Prometheus rules** — `infra/docker/prometheus/rules/*.yml`, baked into the Prometheus image.
- **CloudWatch alarms** — `infra/terraform/modules/monitoring/alerts.tf`, one catalog driving both
  the alarms and the bridge that turns them into Alertmanager alerts.
- **Routing** — `infra/docker/alertmanager/alertmanager.yml`.
- **Rotation** — [`on-call-rotation.md`](on-call-rotation.md).

## Contents

- [Severity matrix](#severity-matrix)
- [How an alert reaches a person](#how-an-alert-reaches-a-person)
- [Getting to Prometheus and Alertmanager](#getting-to-prometheus-and-alertmanager)
- [Test-firing an alert](#test-firing-an-alert)
- [Silencing](#silencing)
- [The noisy-alert review](#the-noisy-alert-review)
- [The alerts](#the-alerts) — one section per alert, alphabetical within each group

## Severity matrix

Three levels, and the vocabulary is closed: `critical`, `warning`, `info`. Alertmanager has one
route per value and no catch-all beneath them, and CI rejects a fourth.

| Severity   | Promise                                                      | Where it goes                          | Response time             | Out of hours                        |
| ---------- | ------------------------------------------------------------ | -------------------------------------- | ------------------------- | ----------------------------------- |
| `critical` | Users are affected now, or money/data is being lost now.     | Paging integration, re-paged hourly    | Acknowledge within 15 min | **Wakes the primary on-call, 24/7** |
| `warning`  | Something is broken or degrading and will become `critical`. | Ticket integration, repeated every 12h | Next working day          | Queued; nobody is woken             |
| `info`     | Defined, evaluated, visible — routed to nobody.              | Dropped at Alertmanager                | None                      | None                                |

**What makes something `critical`.** Not "how bad does this look" but: _is a human needed in the
next fifteen minutes, and is there something they can do?_ An alert that fails either half belongs
at `warning`. A saturated database at 3am with no action available until morning is a `warning`
however alarming the graph is; a halted payment pipeline is `critical` at any hour because every
minute of it is a school whose subscription state is wrong.

**What `info` is for.** It is the tier a noisy alert is demoted _to_ while it is being tuned —
still firing, still visible in Prometheus and in the Alertmanager UI, reaching nobody. Demoting is
reversible and leaves the history intact; deleting an alert loses both.

## How an alert reaches a person

```
  Prometheus rules ─────────────┐
  (infra/docker/prometheus/     │
   rules/*.yml)                 ▼
                          Alertmanager ──► severity route ──► on-call provider ──► human
                                ▲            (page/ticket)
  CloudWatch alarms ─► SNS ─► bridge Lambda
  (alerts.tf)                (alert-bridge)
```

Two sources, one destination, on purpose. The split at the source is forced — Fargate has no host
for `node_exporter`, and RDS replica lag, ElastiCache CPU, ACM expiry and the ST-149 synthetic probe
have no scrapeable endpoint at all — but the split stops there. Both planes use the same three
severities, the same receivers, the same silences and the same review below. There is exactly one
place to look during an incident and exactly one place to silence something.

The bridge (`modules/monitoring/lambda/cloudwatch-alert-bridge/index.mjs`) maps `ALARM` to firing
and `OK` to resolved, and deliberately **ignores `INSUFFICIENT_DATA`** — that state is the absence
of an opinion, not a third one. Alarms where missing data genuinely is the signal (the probe,
replica lag) set `treat_missing_data = "breaching"` so CloudWatch reports it as `ALARM` instead.

## Getting to Prometheus and Alertmanager

Neither has a public endpoint; the `monitoring` security group admits only the bastion — the same
access model as Grafana ([`metrics-dashboard-catalog.md`](metrics-dashboard-catalog.md)) and the
databases ([`pgbouncer-conventions.md`](pgbouncer-conventions.md)).

```bash
ssh -L 9090:prometheus.metrics.internal:9090 \
    -L 9093:alertmanager.metrics.internal:9093 \
    -L 3000:grafana.metrics.internal:3000 \
    ec2-user@<bastion-public-ip>
# http://localhost:9090/alerts   — which rules are firing, and their current values
# http://localhost:9093          — what Alertmanager did with them, and silences
```

The bastion's public IP is `module.network`'s `bastion_public_ip` output. `amtool` ships inside the
Alertmanager image; run it from your own machine against the forwarded port, or
`aws ecs execute-command` into the task.

## Test-firing an alert

Run this drill whenever the receiver URLs are rotated, when the on-call provider's routing changes,
and as part of onboarding a new on-call engineer. It proves the whole path — not just that
Alertmanager is up.

**One severity at a time, and tell the rotation first.** A `critical` test fire wakes whoever is on
call.

**Give each severity its own `service` value.** This is not cosmetic. The inhibit rule suppresses a
`warning` whose `service` matches a firing `critical` — so a drill that uses one `service` for both
shows the critical page arriving and the warning ticket never appearing, which looks exactly like a
broken ticket route. That is the rule working as designed; see the `inhibit_rules` comment in
`alertmanager.yml`.

```bash
# 1. The paging path. `service: drill-page` is its own subject, so nothing inhibits it and nothing
#    it fires inhibits anything else.
curl -sf -XPOST http://localhost:9093/api/v2/alerts \
  -H 'content-type: application/json' \
  -d '[{
        "labels": {"alertname": "RoutingDrill", "severity": "critical", "service": "drill-page"},
        "annotations": {"summary": "Routing drill - not a real alert"},
        "endsAt": "'"$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)"'"
      }]'

# 2. Confirm Alertmanager routed it, and that it is not suppressed. The state must be `active`:
#    `suppressed` means an inhibit rule or a silence swallowed it and step 3 will never happen.
amtool --alertmanager.url=http://localhost:9093 alert query --output=extended alertname=RoutingDrill

# 3. Confirm it arrived at the on-call provider, at the expected urgency, for the expected person.
#    This is the step that actually tests the acceptance criterion; the two above only prove the
#    alert got as far as Alertmanager.

# 4. The ticket path - note the different service value, per the warning above.
curl -sf -XPOST http://localhost:9093/api/v2/alerts \
  -H 'content-type: application/json' \
  -d '[{
        "labels": {"alertname": "TicketDrill", "severity": "warning", "service": "drill-ticket"},
        "annotations": {"summary": "Routing drill - not a real alert"},
        "endsAt": "'"$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%SZ)"'"
      }]'
#    Confirm it lands as a ticket and wakes nobody.
```

The `endsAt` ten minutes out matters: an alert pushed through the API with no `endsAt` lingers for
`resolve_timeout`, and one pushed with a long horizon has to be silenced to clear.

Two counters in Alertmanager's own `/metrics` separate "the provider is misconfigured" from "the
URL is wrong" — they say whether delivery was even attempted:

```bash
curl -s http://localhost:9093/metrics | grep 'notifications.*webhook'
# alertmanager_notifications_total{integration="webhook"}                     attempted
# alertmanager_notifications_failed_total{integration="webhook",reason="..."} and rejected
```

**The CloudWatch half of the path** is tested separately, because it exercises the bridge, SNS and
the KMS key policy that the API call above does not:

```bash
aws cloudwatch set-alarm-state \
  --alarm-name studafy-staging-redis-engine-cpu-high \
  --state-value ALARM \
  --state-reason "Routing drill $(date -u +%F)"

# Then put it back, which also tests that a resolve closes the incident:
aws cloudwatch set-alarm-state \
  --alarm-name studafy-staging-redis-engine-cpu-high \
  --state-value OK --state-reason "Routing drill complete"
```

Use a `warning` alarm for this half unless you are deliberately testing the paging path — and check
`/aws/lambda/<prefix>-alert-bridge` if nothing arrives; an unknown alarm name or a rejected POST is
logged there with the reason.

## Silencing

```bash
amtool --alertmanager.url=http://localhost:9093 silence add \
  alertname=QueueDepthHigh messaging_destination_name=ai-ingestion \
  --duration=4h --comment="ST-xxx bulk import, expected backlog, draining"
```

Two rules, both of which exist because a silence is the mechanism most likely to hide a real
outage:

1. **Always give a duration and a comment.** `amtool` will accept neither by default; an
   open-ended, unexplained silence is indistinguishable from a broken alert and will outlive
   everyone's memory of why it is there.
2. **Silence the narrowest thing that works.** `alertname=X` plus the label identifying the one
   affected subject, never `severity=warning` — that last one silences alerts that have not been
   written yet.

Expiring silences are reviewed in the meeting below.

## The noisy-alert review

**Fortnightly, 30 minutes, in the same slot as the on-call handover.** The outgoing primary runs it;
the incoming primary must be there, because they inherit whatever is not fixed.

Alerting decays in one direction: rules get added, none get removed, and the pager slowly becomes
background noise until a real page is missed. This meeting is the only thing that pushes back.

**Inputs.** Everything the rotation saw in the last two weeks:

```bash
# Every alert Alertmanager has handled, grouped — the ones that fired repeatedly are the agenda.
amtool --alertmanager.url=http://localhost:9093 alert query --expired

# Silences that expired or are about to. A repeatedly re-created silence is a broken alert.
amtool --alertmanager.url=http://localhost:9093 silence query --expired
```

plus the on-call provider's own incident list, which is the only place that records what was
_acknowledged out of hours_ — the number this meeting exists to drive down.

**For each alert that fired more than twice, answer one question: did a human do something?**

| Answer                                      | Action                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Yes, and it was urgent                      | Nothing. The alert is working.                                                                                                              |
| Yes, but it could have waited until morning | Demote `critical` → `warning`. Record why in the rule's own comment.                                                                        |
| Yes, and it was the same fix every time     | The fix is the work item. File it, and leave the alert alone until it ships.                                                                |
| No — it resolved on its own                 | The threshold or the `for:` is wrong. Widen it to what the system actually does, or lengthen `for:`. Do not delete it.                      |
| No — nobody knew what to do                 | The runbook section here is the defect, not the rule.                                                                                       |
| No, and it is never actionable              | Demote to `info` for one cycle. If nothing misses it, delete it — rule _and_ runbook section, in one change, or CI will fail on the orphan. |

**Two standing checks**, whatever else came up:

- **Did anything page that has no runbook section here?** It cannot, by construction — CI rejects
  it. Confirm the check still runs; a disabled check is how that guarantee ends.
- **Did the watchdog ever stop?** A gap in the heartbeat is an alerting outage that nothing else
  reports. See [`Watchdog`](#watchdog).

**Output.** Edits to `infra/docker/prometheus/rules/*.yml` or `alerts.tf` land as a normal PR with
the reasoning in the rule's own comment — the threshold is where the next person looks, not the
meeting notes. Everything deferred becomes a ticket. If neither happened, the meeting did not.

---

# The alerts

## API SLOs

The two SLOs, defined once in `infra/docker/prometheus/rules/slo.yml` and alerted on with the
multiwindow burn-rate scheme from the Google SRE Workbook:

- **Availability** — 99.9% of API requests over 30 days are not `5xx`.
- **Latency** — 99% of API requests over 30 days complete within 500ms.

Health checks are excluded from both. `apps/realtime` is deliberately not covered — its "request
duration" is a WebSocket connection lifetime; its SLO is [`RealtimeProbeLatencyHigh`](#realtimeprobelatencyhigh).

### ApiAvailabilityFastBurn

**Means.** `apps/api` is returning `5xx` fast enough to exhaust a month of error budget in days.
Users are seeing errors right now.

**Confirm.** Grafana → **API — RED** → error rate by route. One route or all of them is the first
fork in the road:

```promql
sum by (http_route) (rate(http_server_request_duration_count{job="api",http_response_status_code=~"5.."}[5m]))
```

**Act.** In order of how often it is the answer: (1) a deploy — check the "Recent deploys" widget on
the `<prefix>-operations` CloudWatch dashboard and roll back per
[`deploy-rollback.md`](deploy-rollback.md); (2) a dependency — check
[`PostgresStorageLow`](#postgresstoragelow), [`RedisCpuHigh`](#rediscpuhigh) and the RDS CPU alarms,
since a saturated database surfaces here first; (3) one route only — pull a trace in Grafana →
Explore → Tempo, filtered to that route and `status=error`.

**Escalate.** If it is not a deploy and not a dependency within 15 minutes, escalate to secondary.

### ApiAvailabilitySlowBurn

**Means.** A low, persistent `5xx` rate — too small to notice, large enough to spend the month's
budget before the month ends. Usually one broken endpoint, or one tenant hitting an edge case.

**Confirm.** Same query as above over `[6h]`, grouped by route. A slow burn is nearly always a
single `http_route` with a flat, non-zero error rate.

**Act.** Find the route, pull an errored trace for it in Tempo, fix it as ordinary work. There is
nothing to do at 3am and this alert does not page.

**Escalate.** No. If the budget is nearly exhausted, that is a planning conversation, not a page.

### ApiLatencyFastBurn

**Means.** Requests are exceeding the 500ms objective fast enough to exhaust a month of latency
budget in days. The API is up and answering slowly, which users experience as worse than an error.

**Confirm.** Grafana → **API — RED** → p95/p99 by route. Then decide whether it is the app or what
it waits on:

```promql
histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_bucket{job="api"}[5m])))
```

**Act.** Check the database first — RDS CPU, PgBouncer saturation
([`pgbouncer-conventions.md`](pgbouncer-conventions.md)) and
[`PostgresReplicaLagHigh`](#postgresreplicalaghigh) if the slow routes are reporting endpoints. If
the database is healthy, a Tempo trace for a slow request shows which span owns the time.

**Escalate.** As for `ApiAvailabilityFastBurn`.

### ApiLatencySlowBurn

**Means.** A persistent tail of slow requests. Typically a query that stopped using an index, or a
table that outgrew one.

**Confirm.** p95 by route over `[6h]`. Compare against the same window a week earlier — slow burns
are usually a step change on a deploy, not a drift.

**Act.** Ordinary work. `pg_stat_statements` is enabled ([`postgres-conventions.md`](postgres-conventions.md));
the slow route's dominant query is nearly always at the top of it by total time.

**Escalate.** No.

## Queues

All from `startQueueGauges()` (`packages/observability/src/queueMetrics.ts`), observed on every
scrape. Thresholds are uniform across queues by design — see `queues.yml`'s header for why, and for
which queues are the likeliest legitimate offenders.

### QueueDepthHigh

**Means.** Over 1000 jobs waiting on one queue for 15 minutes. On its own this is a _load_ signal,
not a fault.

**Confirm.** Check the age alongside it — this is the whole point of having both:

```promql
bullmq_queue_jobs{job="workers",state="waiting"}
bullmq_queue_backlog_age{job="workers"}
```

Deep **and draining** (age flat or falling) is a busy system. Deep **and not draining** (age rising)
is a stopped one, and [`QueueBacklogStalled`](#queuebacklogstalled) is about to fire.

**Act.** If it is draining: confirm the source of the burst (a bulk import, a school onboarding, a
scheduled sweep) and let it drain. If it is a recurring burst, the workers' task count is the lever.
If it is not draining, follow `QueueBacklogStalled`.

**Escalate.** No, unless it turns into `QueueBacklogStalled`.

### QueueBacklogAgeHigh

**Means.** The oldest eligible job on a queue has waited over 5 minutes. The consumer is behind, not
stopped.

**Confirm.** Depth and throughput together tell you which:

```promql
sum by (messaging_destination_name, outcome) (rate(bullmq_job_outcomes_total{job="workers"}[5m]))
```

Throughput near zero with depth rising is a stopped consumer. Throughput healthy with depth rising
is genuine overload.

**Act.** Overload: scale the workers service, or find what produced the burst. A single slow job
type: check p95 duration by queue on the **Workers** dashboard — an LLM-bound queue
(`ai-ingestion`, `ai-exam-generation`) slowing down under provider latency is expected and self-
correcting.

**Escalate.** No.

### QueueBacklogStalled

**Means.** Nothing has been consumed from a queue in 30 minutes. This is not slowness.

**Confirm.**

```promql
rate(bullmq_job_outcomes_total{job="workers"}[10m])   # expect ~0 for the affected queue
up{job="workers"}                                      # are the tasks even being scraped
```

**Act.** In order: (1) is the workers service running — ECS desired vs running count; (2) can it
reach Redis — `ElastiCache` alarms and the workers' own logs for connection errors; (3) is a
processor deadlocked — `active` count pinned at the concurrency limit with zero completions is the
signature, and the fix is to restart the service; (4) is it a poison job failing and re-entering the
queue — the failed count will be climbing in step.

**Escalate.** 15 minutes. A stalled queue silently stops notifications, reports, imports and
billing sweeps at once.

### NotificationDeadLetterArrived

**Means.** Notification dispatch jobs exhausted their retries in the last 30 minutes and were parked
in `app.notification_dead_letters`. Recipients did not get what they were owed, and nothing retries
them without an operator.

**Note.** This alert auto-resolves 30 minutes after the last arrival — it counts arrivals, not the
standing size of the table. **Resolved means "no new dead letters", never "the store is empty".**

**Confirm.** The durable record is per tenant, so query it per school (the table is RLS-forced):

```sql
SET LOCAL ROLE studafy_admin;
SELECT set_config('app.school_id', '<school-uuid>', true);
SELECT queue_name, job_name, error_class, error_message, failed_at
FROM app.notification_dead_letters
WHERE replayed_at IS NULL
ORDER BY failed_at DESC;
```

The structured log line is the faster route to _which_ school: search Loki for
`event="notification_dispatch_dead_lettered"` ([`log-aggregation.md`](log-aggregation.md)) — it
carries `school_id`, `queue`, and the error, and is written even when the database write fails.

**Act.** Read `error_class`. A provider outage (FCM, SES) that has since recovered means replay. A
malformed payload or a deleted recipient means the row is correct and should be marked
`replayed_at` with a note rather than retried. Replay is per row, onto the _origin_ queue, not onto
`notifications-dlq` — that name is a handle for the tool, and has no worker attached.

**Escalate.** No, unless the count is large enough to suggest a systemic dispatch failure, in which
case treat it as an incident and check FCM/SES credentials first.

### BillingDeadLetterArrived

**Means.** Stripe billing events exhausted their retries and were parked at
`app.billing_events.status = 'dlq'`. Each one is a subscription transition Stripe considers
delivered and this system never applied — a school that paid and is not active, or cancelled and
still is.

**Critical, where its notifications counterpart is a warning.** The divergence does not heal, and
it grows with every subsequent event for the same subscription.

**Confirm.** `app.billing_events` is global (`studafy_admin` only, no tenant GUC needed):

```sql
SET LOCAL ROLE studafy_admin;
SELECT provider_event_id, event_type, effective_at, attempt_count, last_error
FROM app.billing_events
WHERE status = 'dlq'
ORDER BY received_at DESC
LIMIT 50;
```

**Act.** `last_error` distinguishes the two cases. _Transient_ (a database or Stripe API failure
since recovered): re-enqueue a `process-billing-event` job carrying the `provider_event_id` — the
payload is already durable in the row, and the processor re-folds the subscription's whole history,
so a replay is safe and order-independent. _Terminal_ (unattributable customer, an event type with
no mapping): the row is correct; reconcile the affected subscription against Stripe by hand and
record what was done.

**Escalate.** Involve whoever owns billing for any event touching a school's active/suspended state.
Do not wait for business hours — a suspended school that has paid is a support incident already
in progress.

## Inbound webhooks

### StripeWebhookFailureRateHigh

**Means.** Over 5% of Stripe webhook deliveries are returning `5xx`. Stripe retries with backoff for
up to three days and then **stops permanently**; events lost that way cannot be recovered from this
side.

**Confirm.**

```promql
sum(rate(http_server_request_duration_count{job="api",http_route="/api/subscriptions/webhook/stripe",http_response_status_code=~"5.."}[5m]))
```

Cross-check the Stripe dashboard's own webhook delivery log — it shows the response body, which is
usually faster than reading ours.

**Act.** The endpoint verifies a signature and writes one row before doing anything else, so a `5xx`
here is nearly always the database being unreachable rather than billing logic. Check the RDS and
PgBouncer alarms first. If the database is healthy, pull an errored trace for the route in Tempo.

**Escalate.** 15 minutes. The three-day retry window sounds generous and is not — a weekend outage
spends most of it.

### WebhookEndpointFailureRateHigh

**Means.** A non-Stripe inbound webhook route (`/erpnext/webhooks`, `/email/webhooks/sns`, or any
added later — the rule matches the pattern, not a list) is rejecting over 10% of deliveries.

**Confirm.** The alert names the route in `{{ $labels.http_route }}`. Then:

```promql
sum by (http_response_status_code) (rate(http_server_request_duration_count{job="api",http_route="<the route>"}[15m]))
```

**Act.** ERPNext: usually a signature mismatch after a shared-secret rotation, or a payload with no
`school_id` — see [`tenant-provisioning-checklist.md`](tenant-provisioning-checklist.md). SES/SNS:
usually SNS signature verification failing, which is covered in
[`deliverability.md`](deliverability.md).

**Escalate.** No. Both upstreams retry, and neither carries money.

## Payment pipeline

Both from `app.billing_events`' unresolved tail, read on every scrape by
`apps/workers/src/metrics/billing-pipeline.ts`. Age, not depth: a burst of renewals is a deep
backlog that drains, and a dead consumer is a shallow one that does not.

### BillingEventPipelineStalling

**Means.** The oldest unresolved billing event has been waiting over 5 minutes. Intake is working;
something downstream is slow.

**Confirm.**

```promql
billing_events_backlog_age
billing_events_unresolved
```

Rising depth with rising age is a consumer falling behind. Flat depth with rising age is one stuck
event at the head of the queue.

**Act.** Check the `billing` queue's own health ([`QueueBacklogAgeHigh`](#queuebacklogagehigh)) —
`process-billing-event` jobs run there, so a busy billing queue explains this directly. One stuck
event: find it with the `BillingDeadLetterArrived` query above but filtered to
`status IN ('pending','failed')`.

**Escalate.** No, unless it becomes `BillingEventPipelineHalted`.

### BillingEventPipelineHalted

**Means.** Billing events have been accepted and not applied for 15 minutes. Every affected school's
subscription state is stale — including schools that have paid and schools that have cancelled.

**Confirm.** Same two series. Then check the workers service is running at all
([`ServiceMetricsTargetsAbsent`](#servicemetricstargetsabsent)), since nothing consumes the queue if
it is not.

**Act.** (1) Is `apps/workers` running and consuming — ECS running count, and the `billing` queue's
throughput; (2) can it reach Postgres — the retry path opens its own connection, so a connection
limit reached elsewhere shows up here first, see
[`pgbouncer-conventions.md`](pgbouncer-conventions.md); (3) is one poison event blocking the head —
if so, dead-letter it deliberately rather than letting it hold the pipeline.

**Escalate.** Immediately, and tell whoever owns billing even if you can fix it — entitlement state
that was wrong for an hour usually needs a reconciliation pass afterwards, which is not something
this runbook can do for you.

## Scrape health and the alerting pipeline

### ServiceMetricsTargetDown

**Means.** Prometheus has failed to scrape a task for 10 minutes. The metrics endpoint shares a
process with the service, so this is more often a wedged task than a broken exporter — and while it
lasts, every SLO and queue rule is blind to that task.

**Confirm.**

```promql
up{job=~"api|realtime|workers"}
```

The alert carries `instance`. Compare against the ECS service's running count: a task that ECS also
considers unhealthy is being replaced already.

**Act.** If ECS has not noticed, the task is alive enough to pass its health check and not alive
enough to serve metrics — stop it and let ECS replace it. If several tasks are down at once, this is
not a task problem; check the ALB target group and the `monitoring` security group.

**Escalate.** If more than one task of the same service is affected.

### ServiceMetricsTargetsAbsent

**Means.** Cloud Map is returning _no_ addresses for a service — not that its metrics are broken,
that it has no running task registered. `up == 0` cannot catch this, because there is no `up` series
left to be zero.

**Confirm.** ECS desired vs running count for that service first, before assuming discovery is at
fault. A deploy that failed every task looks exactly like this and is far more likely than a Cloud
Map failure.

**Act.** Treat as a total outage of that service. [`deploy-rollback.md`](deploy-rollback.md) if a
deploy is in flight. If tasks _are_ running, the registration is the fault — check the service's
`serviceRegistries` block (`infra/deploy/ecs/*/service.json.tpl`) and that
`metrics_discovery_service_arns` was populated into the environment file.

**Escalate.** Immediately for `api` or `realtime`.

### ExporterTargetDown

**Means.** `postgres_exporter` or `mysqld_exporter` cannot be scraped for 15 minutes. Database
dashboards are blind; the database itself is not necessarily affected, and its own CloudWatch alarms
are unaffected either way.

**Confirm.** `up{job=~"postgres-exporter|mysqld-exporter"}`, then the exporter's ECS task logs.

**Act.** A rotated database credential is the usual cause — the DSN comes from the `monitoring`
secret container's `POSTGRES_EXPORTER_DSN` / `MYSQLD_EXPORTER_DSN`, and the monitoring role itself is
a manual bootstrap step ([`postgres-conventions.md`](postgres-conventions.md)'s "Monitoring role").
Otherwise restart the exporter task.

**Escalate.** No.

### Watchdog

**Means.** Nothing, while it is firing. This alert always fires; it is routed to a heartbeat
receiver and the on-call provider raises an incident when the pings **stop**.

**If you are reading this because the heartbeat stopped**, the alerting system itself is down and
nothing else in this catalog can tell you so. In likelihood order: Prometheus is not running or not
evaluating; Alertmanager is not running (it runs at `desired_count = 1` — a deliberate trade,
documented in `alertmanager.tf`, and this heartbeat is the mitigation it rests on); the heartbeat
receiver URL was rotated without updating the `monitoring` secret; or network egress from the
monitoring plane is broken.

**Confirm.** Port-forward and check both: `http://localhost:9090/alerts` should list `Watchdog` as
firing, and `http://localhost:9093` should show it in the heartbeat route.

**Act.** Restore whichever is down. **Until the heartbeat is back, assume you have no alerting at
all** and watch the dashboards directly.

**If you are reading this because the watchdog reached a human**, the watchdog route is
misconfigured — it must go to the heartbeat integration and nowhere else.

**Escalate.** Immediately. An alerting outage is invisible and looks exactly like a quiet night.

## Infrastructure (CloudWatch)

These arrive through the bridge and carry `source="cloudwatch"` plus the `alarm_name` for
`aws cloudwatch describe-alarms`.

### RdsCpuHigh

**Means.** An RDS instance (`postgres`, `postgres_read`, or `mariadb` — the alert's `service` label
says which) has been over 80% CPU for 10 minutes.

**Confirm.** The `<prefix>-operations` CloudWatch dashboard's "RDS CPU" widget, and Performance
Insights for the instance if enabled.

**Act.** `pg_stat_statements` ([`postgres-conventions.md`](postgres-conventions.md)) ranks queries by
total time; a single query dominating after a deploy is the common case and usually a lost index. A
sustained rise with no query change is growth — the instance class is the lever.

**Escalate.** Only if it is accompanied by [`ApiLatencyFastBurn`](#apilatencyfastburn), which means
users are already feeling it.

### EcsServiceCpuHigh

**Means.** An ECS service has averaged over 80% CPU for 10 minutes.

**Confirm.** The operations dashboard's "ECS services" widget, and whether request rate or queue
depth rose with it.

**Act.** Scale out if load is genuinely up. If load is flat and CPU rose, something changed in the
service — correlate with the "Recent deploys" widget.

**Escalate.** No.

### PostgresReplicaLagHigh

**Means.** The reporting read replica is over 60 seconds behind for 10 minutes. Reporting endpoints
are serving stale data; nothing else is affected.

**Confirm.** The operations dashboard's "PostgreSQL replica lag" widget. Check the _writer's_ CPU and
write throughput too — replica lag is usually caused by the primary, not the replica.

**Act.** A bulk import or a long-running migration on the primary is the usual cause and resolves on
its own. Sustained lag with no write burst means the replica cannot keep up and its instance class is
the lever.

**Escalate.** No.

### PostgresReplicaLagCritical

**Means.** The replica is over 5 minutes behind. Replication is not keeping up, or has stopped —
`treat_missing_data = "breaching"`, so this also fires when `ReplicaLag` stops being published at
all, which is what a broken replica looks like.

**Confirm.** RDS console → the replica instance → replication state. A replica in `error` or
`terminated` state is a different problem from one that is merely behind.

**Act.** If replication has stopped, the replica must be rebuilt — reporting endpoints should be
pointed at the primary in the meantime rather than serving arbitrarily old data. If it is merely
behind, follow `PostgresReplicaLagHigh` and watch it.

**Escalate.** Yes — a rebuild is a planned operation, not an on-call one.

### PostgresStorageLow

**Means.** Under 10 GiB of free storage on the primary. Postgres does not degrade gracefully when it
runs out; it stops accepting writes.

**Confirm.** RDS console → storage, and the growth rate over the last week — the number that matters
is days remaining, not gigabytes.

**Act.** Storage autoscaling if it is enabled will handle this; confirm it is. Otherwise grow the
volume now — it is an online operation. Then find the growth: the usual suspects are
`app.audit_logs` and `app.attendance_records`, both partitioned monthly, so an old partition that
should have been dropped is the first thing to check
([`audit-log-partition-maintenance.md`](../database/audit-log-partition-maintenance.md)).

**Escalate.** If under 5 GiB, or if the growth rate gives less than 48 hours.

### RedisCpuHigh

**Means.** ElastiCache engine CPU over 75% for 10 minutes. Redis carries BullMQ queues, the realtime
pub/sub fan-out and the entitlement cache, so this degrades three unrelated things at once.

**Confirm.** The operations dashboard's "Redis health" widget — CPU alongside `Evictions` and
`CurrConnections`. Evictions rising with CPU means the instance is too small for the working set,
which is a different fix from a hot command.

**Act.** Check queue depth first ([`QueueDepthHigh`](#queuedepthhigh)): a large backlog makes BullMQ's
own polling expensive, so this is often a symptom of a queue problem rather than a cause. See
[`redis-conventions.md`](redis-conventions.md) for the DB-slot assignment if you need to attribute
load.

**Escalate.** If accompanied by `QueueBacklogStalled` or a realtime probe failure.

### RealtimeProbeLatencyHigh

**Means.** End-to-end realtime propagation exceeded the SLO, **or the probe stopped reporting**, for
two consecutive minutes. This is `apps/realtime`'s only SLO and it measures the real client path —
DNS, ALB, TLS, WAF, gateway, Redis fan-out.

The two cases are one alarm on purpose: every successful run publishes a datapoint every minute, so
a wedged probe and a slow one are indistinguishable from the outside and both mean "realtime cannot
be shown to be working".

**Confirm.** The operations dashboard's probe widget (the SLO line is drawn on it). Then check the
probe Lambda's own logs at `/aws/lambda/<prefix>-realtime-probe` — a probe that is failing rather
than slow logs why and publishes nothing.

**Act.** If the probe itself is broken (expired `WS_JWT_SECRET`, Redis auth rotated, a VPC/NAT
change), fix the probe — but treat realtime as unverified until you have. If the probe is healthy and
slow, follow the realtime path: gateway task health, Redis CPU, and whether
[`QueueBacklogStalled`](#queuebacklogstalled) is firing for `outbox-relay`.

**Escalate.** 15 minutes.

### SyntheticCheckFailing

**Means.** One of the five black-box probes (`login-page`, `healthz`, `oauth-start`,
`checkout-page`, `invitation-verify` — the `service` label says which, as `synthetic-<check>`)
failed, **or the probe stopped reporting**, for two consecutive minutes. This is ST-263's
availability SLO (NFR-03): a real, unauthenticated GET against the app's own public entry points,
run from two regions every minute. A `-dr` suffix on `service` (e.g. `synthetic-healthz-dr`) means
the failure is regional — that probe's own region, not `service`'s bare form's region, is the one
that cannot reach the app; see "Confirm" below for the two regions this can mean.

Same "missing data is breaching" reasoning as `RealtimeProbeLatencyHigh` above: every successful run
publishes a datapoint every minute, so a probe that stopped running and a probe that is genuinely
failing look the same from here, and both mean "this entry point cannot be shown to be working".

**What each check actually verifies:**

- `login-page` / `checkout-page` — the SPA shell loads (200) at `/auth/login` / `/pricing`. No
  route in `apps/web` is literally named "checkout"; `/pricing` is the public page the real
  checkout flow starts from — see `lambda/synthetics-probe/index.mjs`'s header for that mapping.
- `healthz` — `GET /healthz` returns `200 {"status":"ok"}`.
- `oauth-start` — `GET /api/auth/oauth/google/start` answers with anything under 500 (a 302 to
  Google when configured, or the route's own coded 404 when it is not — both mean the route is
  mounted and answering; only a 5xx or a timeout fails this check).
- `invitation-verify` — `GET /api/auth/invitations/{token}/verify` against a fixed, never-issued
  token returns `400 INVITATION_INVALID` (see
  [`invitation_verification_matrix.md`](../security/invitation_verification_matrix.md)) —
  deterministic and side-effect-free, so no live invitation fixture is needed.

**Confirm.** The `<prefix>-availability-slo` dashboard: each check has its own widget with both
regions' rolling success rate and the SLO line. A single region dipping while the other holds
means a regional network/DNS/edge problem, not an application outage — check that region's probe
Lambda logs at `/aws/lambda/<prefix>-synthetics-probe` (the log group exists once per region; open
the one in the affected region) for which check failed and why.

**Act.** Both regions failing the same check points at the application: reproduce the exact request
by hand (`curl -i` the same URL) and follow whichever service owns that path — `apps/web`'s
CloudFront distribution for `login-page`/`checkout-page`, `apps/api` for the other three. One
region only failing points at that region's path to the app (DNS resolution, that region's route to
CloudFront/the ALB) rather than the app itself — there is nothing to roll back or restart in the
application.

**Escalate.** 15 minutes — these are the same "is a real user affected right now" question
`RealtimeProbeLatencyHigh` answers, just for the rest of the app.

### CertificateExpiringSoon

**Means.** A TLS certificate (`edge` = the public ALB, `cdn` = CloudFront — the `service` label says
which) expires in under 21 days and ACM has not renewed it.

This should never fire. Both certificates are DNS-validated against Route 53 records Terraform
creates, and ACM begins renewal about 60 days out. Reaching 21 days means renewal has already failed
silently.

**Confirm.** ACM console → the certificate → **Renewal eligibility** and the validation record's
status. Then check the CNAME actually resolves:

```bash
dig +short <validation-name>.<domain> CNAME
```

**Act.** The cause is almost always a missing or changed validation CNAME. Re-create it — the values
are in `aws_acm_certificate.this.domain_validation_options` (`modules/edge/dns.tf`,
`modules/cdn/dns.tf`), and a `terraform apply` restores them if they were deleted outside Terraform.
ACM retries automatically once the record resolves.

**Escalate.** No, at 21 days. File it as work that must land this week.

### CertificateExpiryCritical

**Means.** The same certificate now expires in under 7 days. When it lapses, every user gets a TLS
error — there is no partial failure and no graceful degradation.

**Confirm and act.** As for [`CertificateExpiringSoon`](#certificateexpiringsoon), but do not wait
for the automatic retry to prove itself: after restoring the validation record, request a new
certificate in parallel so there is something to switch to. Note the CDN certificate must be issued
in **us-east-1** — CloudFront accepts no other region.

**Escalate.** Immediately, any hour. Seven days is less runway than it sounds once a holiday or a
person's time off is in the way.
