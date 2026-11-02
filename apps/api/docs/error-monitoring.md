# Backend error monitoring

Sentry error monitoring for the three backend services — `apps/api`, `apps/workers` and
`apps/realtime`. The server-side counterpart of [the web client's](../../web/docs/error-monitoring.md).
The moving parts:

| Layer           | File(s)                                                                     | Responsibility                                                                                                        |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Vendor seam     | `packages/observability/src/errorMonitoring.ts`                             | `initErrorMonitoring`, `captureError`, `forwardLog`, `withErrorMonitoringScope` — the only file importing `@sentry/*` |
| PII scrubbing   | `packages/observability/src/scrubPii.ts`                                    | `beforeSend`/`beforeBreadcrumb` redaction, verified by `scrubPii.test.ts`                                             |
| API catch point | `apps/api/src/middleware/errorHandler.ts`                                   | Reports every 5xx from the central `app.onError` handler                                                              |
| API logs        | `apps/api/src/logger.ts` (`observer`), wired in `apps/api/src/index.ts`     | Forwards `warn`/`error`/`fatal` records                                                                               |
| Workers         | `apps/workers/src/worker.ts` (`runMonitoredJob`), `apps/workers/src/log.ts` | Reports a job's final failed attempt; forwards `warn`/`error` logs                                                    |
| Realtime        | `apps/realtime/src/app.ts` (`onError`, `monitored`)                         | Reports handshake/health-route 500s and throwing WebSocket handlers                                                   |
| Deploy wiring   | `infra/deploy/ecs/*/task-definition.json.tpl`, `infra/deploy/environments/` | `SENTRY_DSN`, `SENTRY_ENVIRONMENT` from each tier's env file, `RELEASE_VERSION` per deploy                            |

SDK: `@sentry/bun` (all three services run on Bun — see `infra/docker/*.Dockerfile`), pinned to the
same `10.70.0` release as the web client's `@sentry/react`.

## Off unless configured

Every export of the seam is a no-op until `initErrorMonitoring()` is called with a DSN. `SENTRY_DSN`
is unset in local dev, in tests and in the OpenAPI generator, so nothing changes there: no Sentry
client, no extra OTel globals, and the API logger does not even materialize its bindings for the
log observer.

## What is sent

| Source                                                                                                                 | Becomes                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| API: any 5xx response (unknown error, or a 5xx `HTTPException`/`CodedHttpException`)                                   | An exception event                                                           |
| API: a 4xx (`CodedHttpException`, `AuthException`, `ZodError`, ...)                                                    | Nothing beyond its existing `warn` log line (which becomes a breadcrumb)     |
| Workers: a job failing on its final attempt (or with `UnrecoverableError`)                                             | An exception event. Attempts BullMQ will retry are not reported.             |
| Realtime: an unexpected throw in `/ws` handshake or a health route, or in a WebSocket `open`/`message`/`close` handler | An exception event                                                           |
| A `warn` log line                                                                                                      | A breadcrumb on the current request's/job's scope — never an event           |
| An `error`/`fatal` log line                                                                                            | An exception event when it carries an `err` Error, otherwise a message event |
| An uncaught exception / unhandled rejection                                                                            | An exception event, then the process exits as it did before                  |

Tags are ids only: `service`, `request_id`, `route` (the matched pattern, e.g.
`/api/students/:id` — never the concrete path), `school_id`, `code` (the API error code), `queue`,
`job_id`, `job_name`, `ws_event`. The user is `{ id }` and nothing else. Events also carry the
active OpenTelemetry trace id, so an issue links straight to its trace in Tempo.

### No double reporting

The error handler and the job wrapper report an error _before_ it is logged; `forwardLog()` then
recognizes the same `Error` object and skips it. A polling loop logging the same failure every cycle
is collapsed by Sentry's `Dedupe` integration.

### Per-request breadcrumbs

Each inbound request (`Bun.serve`'s `fetch`) and each job runs in its own Sentry isolation scope
(`withErrorMonitoringScope`), so breadcrumbs left by one request's `warn` logs never appear on
another tenant's event. This depends on Sentry's `AsyncLocalStorage` context manager, which
`initErrorMonitoring()` registers as the global OTel context manager — that is why it must run
_before_ `startTracing()` in each `index.ts`, and why `startTracing()` keeps an already-registered
manager instead of replacing it.

## What is never sent

- **Request bodies, headers, cookies and query strings.** `RequestData` is not installed and
  `scrubEvent` reduces any `request` to method + path.
- **Credentials and personal data.** Any key in `extra`, `contexts` or breadcrumb `data` matching a
  PII root (email, phone, name, address, password, token, cookie, authorization, session, key, ...)
  is replaced with `"[Redacted]"` at any depth, and emails, phone numbers, JWTs and bearer
  credentials are redacted from free text — messages, exception values and breadcrumb messages. The
  root list starts from the web client's and is deliberately stricter: this platform holds minors'
  data, and a backend error can carry a DB row or provider payload the browser never sees.
- **Console output and outbound URLs.** The `Console`, `Http` and `NodeFetch` integrations are
  removed; logs reach Sentry only through `forwardLog()`.
- `sendDefaultPii` is `false`.

## Why no Sentry performance tracing

Tracing is owned by OpenTelemetry (ST-260): every span goes to the tail-sampling collector, which
keeps errors plus a 10% sample. Sentry's SDK would otherwise install its own global
`TracerProvider`/propagator, and its `Bun.serve` wrapper marks a request "tracing suppressed" when
Sentry tracing is off — either way the collector would lose spans. So `skipOpenTelemetrySetup` is
always on, `BunServer`/`Http`/`NodeFetch` are removed, and no `tracesSampleRate` is configured.

## Env vars

| Var                  | Services               | Set where                                                                     | Notes                                                                                         |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`         | api, workers, realtime | `environment` in each task definition, from `infra/deploy/environments/*.env` | Empty/unset disables monitoring. A DSN only lets a process send events: config, not a secret. |
| `SENTRY_ENVIRONMENT` | api, workers, realtime | `environment` in each task definition, from `infra/deploy/environments/*.env` | Falls back to `APP_ENV` (api) or `NODE_ENV` (workers, realtime).                              |
| `RELEASE_VERSION`    | api, workers, realtime | `environment` in each task definition, `${IMAGE_TAG}`                         | The same immutable image tag the web build uses as its Sentry release.                        |

To turn monitoring on or off for an environment, set `SENTRY_DSN` in that tier's
`infra/deploy/environments/<tier>.env` (empty turns it off) and redeploy.

## Verifying

Locally: run a service with `SENTRY_DSN` pointing at a test project and hit a route that throws, or
log at `error` with an `err`. `packages/observability/src/errorMonitoring.test.ts` covers the no-DSN
no-op, the init options and log forwarding; `apps/api/src/middleware/errorHandler.reporting.test.ts`
covers 5xx reported / 4xx not; `apps/workers/src/worker.test.ts` and
`apps/realtime/src/app.monitoring.test.ts` cover the workers and realtime catch points.
