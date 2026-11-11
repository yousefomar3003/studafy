# Secret rotation schedule

The quarterly calendar, cadence, ownership, and the shared audit/evidence procedure for every
secret-class rotation in this repo. This file is the schedule; the four per-class runbooks in this
directory are the how — see [`README.md`](README.md) for the index. The inventory of every secret
(where it lives, which fly app receives it) lives in
[`secrets-conventions.md`](../secrets-conventions.md).

## Cadence

| Class                            | Automatic rotation                                | Quarterly drill                                 | Runbook                                                          |
| -------------------------------- | ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| DB credentials (Postgres master) | None                                              | **Quarterly, manual**; record the outage window | [`rotation-db.md`](rotation-db.md)                               |
| JWT signing keys                 | Every `JWT_KEY_ROTATION_INTERVAL_MS` (default 7d) | Verify JWKS overlap + audit trail               | [`rotation-jwt-jwks.md`](rotation-jwt-jwks.md)                   |
| Provider API keys                | None                                              | **Quarterly, manual**                           | [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md) |
| Webhook secrets                  | None                                              | **Quarterly, manual**                           | [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md)     |

The three "None" rows are the load-bearing quarterly work. The JWT class exists to be _verified_,
not to be manually rotated.

## Calendar

Quarters and their run week (the first full working week of the quarter; working week =
Sunday–Thursday `Asia/Amman`, [`on-call-rotation.md`](../on-call-rotation.md)'s convention):

| Quarter | Run week (Asia/Amman)              | Reminder auto-open                              |
| ------- | ---------------------------------- | ----------------------------------------------- |
| Q1      | First full working week of January | `1 Jan 09:00` (`secrets-rotation-schedule.yml`) |
| Q2      | First full working week of April   | `1 Apr 09:00`                                   |
| Q3      | First full working week of July    | `1 Jul 09:00`                                   |
| Q4      | First full working week of October | `1 Oct 09:00`                                   |

The first drill under these procedures is **Q4 2026** (October run week); each quarter thereafter.
A drill may be skipped only with the owning role's sign-off, recorded as the quarter's audit entry.

**Calendar automation** is `.github/workflows/secrets-rotation-schedule.yml`: on a cron at
`06:00 UTC` (09:00 Asia/Amman — Jordan is UTC+3 year-round) on 1 Jan/Apr/Jul/Oct, and on manual
`workflow_dispatch`, it opens a `secrets-rotation`-labeled GitHub issue that is the quarter's
checklist and record. The repo has no calendar product integration — a Git issue is the calendar
entry that also holds the evidence.

## Ownership

Roles, not names (repo convention — `on-call-rotation.md`, `launch/README.md`):

- **Executor** (runs the drill): the security-operations role, or the on-call primary as deputy.
- **Reviewer** (signs off evidence): the security role's lead. A drill is complete only when the
  review entry is in the quarter's issue thread.
- **No-man-name rule**: the issues assign by role tag, not GitHub identity.

## Zero-downtime standard

The acceptance criterion for every class is "rotated following the runbook with zero downtime".
What that means per class, honestly:

- **DB**: not met today. Every service shares Supabase's `postgres` login, so new connections are
  refused from the password change until the deploy finishes; the drill records that window
  ([`rotation-db.md`](rotation-db.md) "Honest zero-downtime assessment").
- **JWT**: JWKS overlap keeps the outgoing key verifiable through rotation; bounded by process
  lifetime and access-token TTL ([`rotation-jwt-jwks.md`](rotation-jwt-jwks.md)'s gaps).
- **Provider keys**: released by a normal deploy; the old value stays valid at the provider until
  the final "revoke old" step.
- **Webhooks**: sender-side overlap first, receiver roll second; the reverse order is an incident.

There is no staging environment any more: the drill runs against production
([`rotation-drill.md`](rotation-drill.md)).

## Audit / evidence (the shared procedure)

Rotation events are audited at two layers; the drill records both into the quarter's issue.

### Layer 1 — the deploy run and the secret's history

Every application-secret rotation is released by a run of **Production deploy (fly.io)**; its run
link (Actions tab) is the evidence that the new value was staged onto the fly apps and when. The
`prod` environment's secret list shows each secret's last-updated time. Provider-side changes
(Supabase, Resend, Stripe, ...) are evidenced from that provider's dashboard or audit log.

### Layer 2 — application structured logs

- **JWT rotation**: the api service logs `jwt key rotated` with the new `kid` on every in-process
  rotation (`apps/api/src/index.ts:139`).

  Search the api's logs in Axiom (dataset `studafy-logs`, shipped by
  `infra/fly/log-shipper.toml`) for `jwt key rotated`.

- **Webhook signature rejections** during an overlap are `*_signature_invalid` rows in
  `app.security_events` (the sink in `apps/api/src/lib/security/securityEventSink.ts`) — _zero
  during a clean rotation_, and that zero is part of the evidence.

### Recording the quarter

Each drill ends with one comment on the quarter's issue containing: date/run window, class(es)
rotated, the deploy run links, the zero-downtime gate result per class
(`healthz`/JWKS/pool checks), and reviewer sign-off. The issue is then closed.

## Status table and known gaps

| Secret                                           | Auto-rotation | Drill possible today                     | Notes                                                      |
| ------------------------------------------------ | ------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Supabase `postgres` password                     | No            | Yes (manual; window shown)               | Shared by every service; per-service roles not created yet |
| JWT signing keys (api)                           | Yes (7d)      | Yes (verify-only)                        | In-memory keys; restart gap open                           |
| Provider API keys (LLM/Stripe/OAuth/R2; ERPNext) | No            | Yes, for keys the deploy workflow stages | ERPNext and Tap keys are not in the workflow yet           |
| Webhook secrets (Stripe, Resend; ERPNext)        | No            | Yes                                      | Sender-side overlap required where the sender supports it  |
| Redis Cloud credential (`REDIS_URL`)             | No            | No                                       | No procedure defined yet                                   |

The last row is a pre-existing gap ([`secrets-conventions.md`](../secrets-conventions.md) "Known
gaps"), listed here so the quarterly review has the full inventory rather than a scoped one.
