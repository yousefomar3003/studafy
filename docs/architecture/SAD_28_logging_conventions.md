# Logging and tracing conventions

Source of the logger: [`apps/api/src/logger.ts`](../../apps/api/src/logger.ts). Source of the request
context: [`apps/api/src/request-context.ts`](../../apps/api/src/request-context.ts). This doc is the
conventions every service must follow to keep the log stream queryable and the audit trail traceable —
the modules produce the lines; they cannot enforce how callers use them.

## Stated assumption on the log schema

The ST-054 ticket cites **SAD section 28** as the source of these formats. **The SAD is not in this
repository** — [`db/migrations/000018_create_partitioned_audit_logs.sql`](../../db/migrations/000018_create_partitioned_audit_logs.sql)
records the same gap for section 15, and [`docs/api/global-data-erd.md`](../api/global-data-erd.md) for
section 10. The field list and conventions below are therefore taken from the ticket's own stated
requirements and from the existing `app.audit_logs` column names, rather than inferred from a document
nobody here can read. **This document does not claim that the unavailable SAD text was inspected.** If the
SAD later contradicts this, a follow-up ticket reconciles it.

## Record format

One record is one line of NDJSON on stdout. The wire format matches [pino](https://getpino.io)'s, so
standard tooling and level integers apply — but pino is **not** a dependency: this repo had no logging
library, runs on Bun (where pino's worker-thread transports are a liability), and the format is ~100 lines
of `JSON.stringify`. See `logger.ts`.

```json
{
  "level": 30,
  "time": 1752624000000,
  "service": "api",
  "env": "production",
  "release_version": "sha-abc1234",
  "request_id": "3f2b...",
  "method": "GET",
  "path": "/students",
  "school_id": null,
  "user_id": null,
  "status": 200,
  "duration_ms": 12.481,
  "msg": "request completed"
}
```

| Field             | Source                     | Notes                                                                   |
| ----------------- | -------------------------- | ----------------------------------------------------------------------- |
| `level`           | logger                     | pino integers: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal |
| `time`            | logger                     | `Date.now()`, epoch milliseconds                                        |
| `service`         | `SERVICE_NAME`             | defaults to `api`                                                       |
| `env`             | `NODE_ENV`                 |                                                                         |
| `release_version` | `RELEASE_VERSION`          | `IMAGE_TAG` in deployments; `unknown` locally                           |
| `request_id`      | request-context middleware | generated UUIDv4, one per request                                       |
| `method` / `path` | request-context middleware | path only — **never** the query string                                  |
| `school_id`       | auth middleware (re-child) | `null` until authentication exists                                      |
| `user_id`         | auth middleware (re-child) | `null` until authentication exists                                      |
| `err`             | call site                  | expanded to `type`, `message`, `stack`, bounded `cause`                 |
| `msg`             | call site                  | always last, matching pino's key order                                  |

**Primary search keys sit at the root of the document, never nested.** `school_id`, `user_id`,
`request_id`, and `level` are what queries filter on, and a nested object would force an aggregator to
unpack every line before it could match one.

**Deviation from pino's defaults, stated rather than silent:** pino's default base bindings are `pid` and
`hostname`. We bind `service`, `env`, and `release_version` instead. `pid` is always 1 in a Fargate task,
`os.hostname()` is a syscall, and the awslogs stream prefix already identifies the task — none of the
three would survive a query.

## Levels

`LOG_LEVEL` (default `info`) is the volume knob. A level below the threshold resolves to a no-op **at
logger construction**, so a disabled `debug` call costs nothing at the call site — not a serialization,
not an allocation. Use `trace`/`debug` freely; they are free in production.

| Level   | Use for                                                                  |
| ------- | ------------------------------------------------------------------------ |
| `warn`  | the caller's fault — a 4xx. The request failed; the service did not.     |
| `error` | our fault — a 5xx. Something that should page someone if it is frequent. |
| `fatal` | the process cannot continue.                                             |

## Child loggers and the auth seam

`logger.child(bindings)` derives a logger carrying extra fields. It is cheap by construction: bindings are
held **pre-serialized as a string**, so a child is one string concat rather than an object spread plus
re-serialization of its ancestors.

Duplicate keys are deliberate. A child that re-binds a key its parent already bound emits both, and a JSON
reader keeps the last — so a later binding overrides an earlier one for free. **This is the mechanism the
authentication seam depends on.** Request-context binds `school_id: null` before any identity is known;
an auth middleware runs _inside_ it and therefore cannot be read on the way in. It overrides on the way
through, by re-childing:

```ts
// in a future authentication middleware
c.set("log", c.get("log").child({ school_id: schoolId, user_id: userId }));
```

Anything that refines request context must follow this pattern. Do not reach for `AsyncLocalStorage`: `c`
is already threaded explicitly through every handler and survives every `await` because closures capture.
An ALS store is a module-level global that any module could pull tenant identity out of without declaring
it needs tenant identity — the wrong affordance in a codebase whose central invariant is RLS tenant
isolation. If a driver-level hook ever needs ambient logging (a postgres.js `onnotice`, say), add ALS then,
behind the same `AppOptions` seam, and only around the handler.

## Log injection is structurally impossible, and stays that way only if you follow one rule

NDJSON frames on U+000A and nothing else, so forging a record means emitting a raw newline mid-line.
`JSON.stringify` cannot: ECMA-262's `QuoteJSONString` escapes U+000A, U+000D, `"`, `\`, and every code
point below U+0020. Every dynamic value in `logger.ts` — **keys included** — passes through it, and the
only raw newline in the module is the one the writer appends outside every stringified value. An
attacker-controlled `User-Agent`, path, or field value therefore lands as inert data inside a string.

**The rule: never interpolate an unstringified dynamic value into a line.** A single `,"path":"${path}"`
destroys the guarantee. This is pinned by tests in `logger.test.ts` and `problem.test.ts`.

U+2028 and U+2029 are deliberately left unescaped: they are legal in JSON strings and break only JS
`eval`, not an NDJSON reader, which splits on `\n` alone.

## Errors: `application/problem+json`

Every failed request becomes an RFC 9457 problem document carrying the `request_id`
([`apps/api/src/problem.ts`](../../apps/api/src/problem.ts)) — both ways a request can fail: a handler
threw (`app.onError`), or no route matched it (`app.notFound`, ST-055). There is no third shape, and in
particular a 404 is not the one response a client has to special-case.

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "not your school",
  "code": "AUTHZ_FORBIDDEN",
  "request_id": "3f2b..."
}
```

`code` reuses `ERROR_CODES` from `@studafy/constants`; **error codes are never redeclared**. The envelope
is `problemDetailsSchema` from `@studafy/shared-schemas`, extended with `request_id` — the one extension
member RFC 9457 §3.2 permits.

An unmatched route is the same document, and the only path that populates `instance`:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "The requested path /v1/invalid-route-path does not exist.",
  "instance": "/v1/invalid-route-path",
  "code": "RESOURCE_NOT_FOUND",
  "request_id": "3f2b..."
}
```

**`instance` and `detail` here are `c.req.path`, never `c.req.url`.** This is the only place the API
reflects client-controlled input back to the caller, and `path` excludes the query string. The same
reasoning that keeps a query string off the log line applies harder to a response body: it can carry a
token or a PII filter. The value stays percent-encoded and is escaped by `JSON.stringify`.

`app.notFound` emits **no log line**. The `request completed` line already carries the status, method,
path, and request id, and there is no error object to record beyond it — unlike `onError`, which logs
because a stack and a cause would otherwise be lost. Unmatched routes are mostly scanners probing
`/wp-admin` and `/.env`; a second line each would double the log volume of the least valuable traffic
there is.

**The split to preserve: the log line is the operator's copy and carries the whole error; the body is the
client's and carries a status, a code, and the request id.** A 5xx body includes nothing from the error —
not the message, stack, cause, nor the failing query and bound parameters postgres.js hangs off its
errors. The client gets `request_id`, and that is the handle that finds all of it.

`onError` never calls `.parse()`. Hono invokes it from inside a catch block, so a throw there would escape
to the next dispatch frame and re-enter `onError`. The schema is the compile-time type and the test
oracle, not a runtime step.

## Request lifecycle, from Hono entry to the audit partition

1. **Request arrives.** The in-flight tracker (outermost) counts it so shutdown can drain it.
2. **`requestContext` generates `request_id`** with `crypto.randomUUID()` and childs the root logger with
   `request_id`, `method`, `path`, `school_id`, `user_id`. Both tenant fields are `null` today.
3. **A future auth middleware re-childs** the logger with the real `school_id`/`user_id`.
4. **The handler runs**, reaching its logger via `c.get("log")`.
5. **A tenant write calls `withTenantTransaction`** with `{ schoolId, userId, requestId }`, which issues
   `set_config('app.school_id' | 'app.user_id' | 'app.request_id', …, true)` — transaction-local, because
   PgBouncer runs in transaction mode and a session-level `SET` would leak onto the next request that
   borrows the connection.
6. **The audit writer** (does not exist yet — see below) reads `current_setting('app.request_id', true)`
   and stores it in `app.audit_logs.request_id`, which routes to that month's partition.
7. **Unwinding**, `requestContext` stamps `X-Request-Id` and logs `request completed` with `status` and
   `duration_ms`. The header is set _after_ `next()` so it also covers `onError` responses.

The tracing labels match the database's exactly — `app.school_id`, `app.user_id`, `app.request_id` — so
one identifier joins the HTTP log line to the audit row.

## Performance

The acceptance target is under 1 ms for the whole middleware. Measured overhead is **~0.01 ms** — a ~100×
margin — by `apps/api/tests/benchmark/request-context-benchmark.test.ts`, which CI gates.

That benchmark asserts a **delta** between two identical apps differing only by this middleware, not an
absolute wall-clock time. This is deliberate: an absolute budget on a shared runner measures Hono's
dispatch and the runner's mood, which is why the NFR-05 probe budget had to be widened twice
(500 → 600 → 1000 ms). Subtracting two arms cancels the shared noise. Keep it that way.

```sh
REQUEST_CONTEXT_BENCHMARK=1 bun test tests/benchmark/ --cwd apps/api
```

## What does not exist

Stated plainly, because the gaps matter more than the parts that work:

- **No audit writer.** Nothing in this repository inserts an `app.audit_logs` row. `request_id` is NULL on
  every row that exists. ST-054 ships the transport (the GUC) and the destination (the column, `000026`)
  so the ticket that adds the writer only adds the INSERT. That column is **permanently nullable** — the
  migrations CLI, workers, and scheduled jobs write with no HTTP request behind them.
- **No index on `audit_logs.request_id`,** deliberately: there is no query to serve yet, and the index a
  future lookup wants is school-leading (`school_id, request_id, created_at DESC`), not a tenant-blind one.
- **No authentication.** `school_id` and `user_id` log as `null`. The re-child seam above is how they stop
  being null.
- **Inbound `X-Request-Id` is ignored.** The edge forwards client headers unchanged and there is no trust
  boundary that could make honouring one safe. This id keys the audit trail, so a caller choosing its own
  would be able to pick the identifier for its own audit row. If upstream correlation is ever needed, log
  the caller's value under a separate, explicitly untrusted, length-capped key — never this one.
- **Non-`Error` throws bypass `onError` entirely.** Hono's compose catches with
  `if (err instanceof Error && onError)`, so `throw "boom"` yields a bodyless 500 with no `X-Request-Id`
  and no log line. Throw `Error` subclasses.
- **No log shipping beyond awslogs.** stdout goes to CloudWatch via the Fargate log driver. There is no
  aggregator, no sampling, and no retention policy in this repo.
- **`apps/realtime` and `apps/workers` still use `console.log`.** The logger is not a shared package yet;
  lifting it into `packages/` is the natural follow-up when a second service needs it.
