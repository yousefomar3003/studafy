# Alert catalog (QA-046)

These are the alerts production must have, and the signal each one reads. The repository provides the signals. The rules live in Sentry, Axiom, Fly and the uptime monitor, and **a person with access to those accounts has to create them** (see "Setup" below). Severity follows [on-call-rotation.md](on-call-rotation.md): `critical` pages, `warning` goes to the channel.

## Signals the code provides

| Signal                | Where                                                                      | Source                                                                                               |
| --------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| API readiness         | `GET https://api.studafy.com/readyz`                                       | `apps/api/src/readiness.ts` (database, Redis, storage; 503 while draining)                           |
| Workers liveness      | Fly check `workers_alive` → `GET :8081/healthz`                            | `apps/workers/src/health.ts`: 503 if a poll loop has not cycled for 5 min or a BullMQ worker stopped |
| Workers heartbeat     | Axiom, `msg == "workers heartbeat"` every 60 s                             | same report; `"workers heartbeat: unhealthy"` at `level 50` when not ok                              |
| Error logs            | Axiom, `level >= 50`                                                       | every service's NDJSON logger                                                                        |
| Errors / crashes      | Sentry org `studafy-limited`                                               | `@studafy/observability` error monitoring (api, workers, realtime, web, mobile)                      |
| Queue and DLQ metrics | Fly managed Prometheus (`[metrics]` :9464 in api/workers/realtime `.toml`) | `bullmq.job.outcomes`, `dead_letter.entries`, queue gauges, `http.server.request.duration`           |

## Alerts

| #   | Alert                         | Rule                                                                                                  | Severity | Fire drill (staging)                                                           |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| A1  | API down                      | Uptime monitor on `/readyz`, 1-minute interval, 2 consecutive failures                                | critical | `fly scale count 0 -a <staging api>` for 3 minutes                             |
| A2  | Web down                      | Uptime monitor on `https://app.studafy.com/`, 1-minute interval, 2 consecutive failures               | critical | Point the monitor at a 404 path once                                           |
| A3  | Workers heartbeat missing     | Axiom monitor: no `msg == "workers heartbeat"` in 5 minutes                                           | critical | `fly scale count 0 -a <staging workers>` for 6 minutes                         |
| A4  | Workers unhealthy             | Axiom monitor: any `msg == "workers heartbeat: unhealthy"`; or Fly check `workers_alive` critical     | critical | Stop staging Redis; BullMQ workers stop running and the heartbeat reports them |
| A5  | Error-log spike               | Axiom monitor: count of `level >= 50` per service > 20 in 5 minutes                                   | warning  | Call a staging route that logs at error level 25 times                         |
| A6  | Sentry new issue / regression | Sentry issue alert: "A new issue is created" or "issue changes state from resolved to unresolved"     | warning  | Throw from a staging-only debug route                                          |
| A7  | Sentry spike                  | Sentry issue alert: issue seen > 100 times in 1 hour                                                  | critical | Loop the A6 drill                                                              |
| A8  | Dead-letter growth            | Prometheus: `increase(dead_letter_entries_total[15m]) > 0`                                            | warning  | Enqueue a staging job whose processor always fails until it exhausts retries   |
| A9  | Billing failures              | Axiom: `msg` contains `"invoice"` or `"dunning"` or `"renewal"` with `level >= 50`, any in 15 minutes | critical | Generate a staging invoice against an ERPNext site with a wrong key            |
| A10 | Scan failures                 | Axiom: `level >= 50` and `msg` contains `"scan"`, > 5 in 15 minutes                                   | warning  | Stop the staging scanner app and upload a file                                 |

## Setup (NEEDS HUMAN, once)

1. **Route**: a Slack/Telegram channel for `warning`, and a paging integration for `critical`, per [on-call-rotation.md](on-call-rotation.md).
2. **Uptime**: create A1 and A2 (Better Stack, UptimeRobot, or Sentry Uptime).
3. **Axiom**: create A3, A4, A5, A9 and A10 as monitors on dataset `studafy-logs`, routed as above.
4. **Sentry**: create A6 and A7 for each project.
5. **Fly**: confirm the `workers_alive` check shows up in `fly checks list -a studafy-core-workers`, and connect Fly's managed Grafana/Prometheus to A8.
6. **Drill each alert once in staging**, and record the date, the alert, the time to notify and a screenshot in `docs/qa/evidence/QA-046-alert-drills.md`.
