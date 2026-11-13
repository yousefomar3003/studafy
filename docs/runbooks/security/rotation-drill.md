# Secret rotation drill (quarterly)

The quarter's run, per [`rotation-schedule.md`](rotation-schedule.md): a fixed procedure that takes
each of the four secret classes through its per-class runbook and records the evidence — the
acceptance criterion "each secret class rotated following the runbook with zero downtime, events
audited" verified in one sitting. There is no staging environment any more, so the drill runs
against production, the only deployed tier; plan it for a quiet window. One issue per quarter;
the run week is the first full working week of the quarter (`Asia/Amman`).

## Pre-flight

- [ ] Quarter's `secrets-rotation` issue is open (auto-opened by
      `.github/workflows/secrets-rotation-schedule.yml`; dispatch manually if it didn't fire).
- [ ] Production is healthy: `curl -sf https://api.studafy.com/healthz` answers 200, and
      `fly status --app studafy-core-api` / `--app studafy-core-workers` show started machines.
- [ ] Executor can edit the `prod` GitHub Environment's secrets and run **Production deploy
      (fly.io)**, and has `fly` access to the `studafy-core-*` apps.
- [ ] No other run of the deploy workflow is in flight (each rotation below ends in one).

## Run order

Run in this order; each class's step below delegates to its runbook, whose commands are the
authority. Record **evidence after every step** rather than once at the end (each class's deploy
run and log window stay easy to find; see [`rotation-schedule.md`](rotation-schedule.md)'s audit section).

### 1. JWT signing keys — verify (fastest; do first so a snag leaves the manual steps un-started)

Follow [`rotation-jwt-jwks.md`](rotation-jwt-jwks.md): fetch the JWKS, restart the api machines,
watch both kids change, and verify a fresh token against the live JWKS.
Evidence: the JWKS JSON with two kids, the `jwt key rotated` log lines for the window.

Zero-downtime gate: `healthz` 200 across the restart; tokens verify after.

### 2. DB credentials — manual rotation + gate

Follow [`rotation-db.md`](rotation-db.md): new password at Supabase → `DATABASE_PASSWORD` in the
`prod` environment → run the deploy workflow → verify.
Evidence: the deploy run's link, the migration step's "database is up to date" line, and `readyz`
answering 200 afterwards.
Gate: this class is **not** zero-downtime today (see its runbook); record how long new connections
were refused instead of asserting none were.

### 3. Provider API keys — rotate one live provider key

Follow [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md) for **one** key (e.g.
`AI_LLM_API_KEY`): acquire new at the provider → update the `prod` secret → run the deploy
workflow → verify the provider call 200s → revoke old after the grace window.
Evidence: the deploy run's link, the provider call, and the secret's "updated" time in GitHub.
Zero-downtime gate: `healthz` 200 through the deploy.

### 4. Webhook secrets — rotate one sender-backed webhook

Follow [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md) (Stripe or Resend, whichever is
configured). Update sender-side first, then the receiver, then
prove a real delivery verifies.
Evidence: the delivery's 200/log line, and — if recorded — zero `*_signature_invalid` rows during
the overlap (`app.security_events`).
Zero-downtime gate: no dropped event during the sender-overlap window; route answers verified.

## Abort criteria

Stop the drill, restore as instructed by the class runbook, and record the failure in the issue:

- Any step where a deploy fails or a service stops answering `healthz` — fix the _cause_ before
  retrying. A failed migration step releases nothing.
- A webhook delivery rejected by signature after the sender-side overlap should have
  been consumed (`*_signature_invalid` > 0 during the overlap window) — that is a rotated-out-of-
  step incident path, not a glitch.
- The deploy after a DB rotation fails on authentication; triage per
  [`rotation-db.md`](rotation-db.md)'s failure section before touching the secret again.

## Post-drill record

One comment on the quarter's issue containing:

- Run window (dates, Asia/Amman) and executor/reviewer roles.
- Per class: what was rotated or verified, the evidence (deploy run links, JWKS kids, gate
  results), and the signed-off reviewer role.
- Any known-gap row from the schedule's status table that was skipped, and why.
- Next quarter's date.

Closing rule: an issue closes with the review entry; a skipped class with no sign-off stays open.
