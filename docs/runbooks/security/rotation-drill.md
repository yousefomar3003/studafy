# Secret rotation drill (quarterly)

The quarter's run, per [`rotation-schedule.md`](rotation-schedule.md): a fixed procedure that takes
each of the four secret classes through its per-class runbook and records the evidence — the
acceptance criterion "each secret class rotated in staging following the runbook with zero
downtime, events audited" verified in one sitting. One issue per quarter;
the run week is the first full working week of the quarter (`Asia/Amman`).

## Pre-flight

- [ ] Quarter's `secrets-rotation` issue is open (auto-opened by
      `.github/workflows/secrets-rotation-schedule.yml`; dispatch manually if it didn't fire).
- [ ] Staging is deployed and healthy: `curl -sf https://staging-api.studafy.com/healthz` answers
      200, `aws ecs describe-services --cluster <staging cluster> --services \
<name_prefix>-{api,realtime,workers}` each show `RUNNING`.
- [ ] Executor has the environment's apply exports:
      `TF_VAR_bastion_allowed_ssh_cidrs`, `TF_VAR_bastion_key_name`, and, for the app-secret
      steps, access to the per-service Secrets Manager ARNs (`secretsmanager:GetSecretValue` on
      each `secrets_service_secret_arns` entry).
- [ ] No `staging-deploy` run is in flight (the rolling updates in steps 3 and 4 share the ECS
      services).

## Run order

Run in this order; each class's step below delegates to its runbook, whose commands are the
authority. Record **evidence after every step** rather than once at the end (the CloudTrail window
per class stays greppable; see [`rotation-schedule.md`](rotation-schedule.md)'s audit section).

### 1. JWT signing keys — verify (fastest; do first so a snag leaves the manual steps un-started)

Follow [`rotation-jwt-jwks.md`](rotation-jwt-jwks.md): fetch the JWKS, force an api rolling update,
watch both kids change, and verify a fresh token against the live JWKS.
Evidence: the JWKS JSON with two kids, the `jwt key rotated` log lines for the window.

Zero-downtime gate: `healthz` 200 across the force-new-deployment; tokens verify after.

### 2. DB credentials — on-demand rotation + gate

Follow [`rotation-db.md`](rotation-db.md): `rotate-secret` → poll `describe-secret` until no
`AWSPENDING` → prove the new password with `psql`.
Evidence: `LastRotatedDate`/version stages output, the `psql` `now()` result, and the pgbouncer
pool check (`SHOW POOLS` from the bastion, or an app-tier `select now()` against the pool).
Zero-downtime gate: `healthz` 200 through the run; pooler's own `api_username`/`api_password`
connection succeeds.

### 3. Provider API keys — rotate one live provider key

Follow [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md) for **one** key (e.g.
`ANTHROPIC_API_KEY` or, if none is wired yet, wire + rotate the first one): acquire new at the
provider → `rotate-app-secret.sh` → verify the provider call 200s → revoke old after the grace
window.
Evidence: the script output (service stabilized), the provider call, and the CloudTrail
`PutSecretValue`/`UpdateSecretVersionStage`/`UpdateService` events.
Zero-downtime gate: rolling update with no task below desired count; `healthz` 200.

### 4. Webhook secrets — rotate one sender-backed webhook

Follow [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md) (Stripe is the realistic choice
for staging; ERPNext if the plane is exercised). Update sender-side first, then the receiver, then
prove a real delivery verifies.
Evidence: the delivery's 200/log line, and — if recorded — zero `*_signature_invalid` rows during
the overlap (`app.security_events`).
Zero-downtime gate: no dropped event during the sender-overlap window; route answers verified.

## Abort criteria

Stop the drill, restore as instructed by the class runbook, and record the failure in the issue:

- Any step where the service fails to stay `RUNNING` (circuit breaker [usually] rolls it back —
  fix the _cause_ before retrying).
- A webhook delivery rejected by signature after the sender-side overlap should have
  been consumed (`*_signature_invalid` > 0 during the overlap window) — that is a rotated-out-of-
  step incident path, not a glitch.
- The DB rotation Lambda fails (`describe-secret` stuck with `AWSPENDING`); triage per
  [`rotation-db.md`](rotation-db.md)'s failure section before touching the secret again.

## Post-drill record

One comment on the quarter's issue containing:

- Run window (dates, Asia/Amman) and executor/reviewer roles.
- Per class: what was rotated or verified, the evidence (CloudTrail event names, JWKS kids, gate
  results), and the signed-off reviewer role.
- Any known-gap row from the schedule's status table that was skipped, and why.
- Next quarter's date.

Closing rule: an issue closes with the review entry; a skipped class with no sign-off stays open.
