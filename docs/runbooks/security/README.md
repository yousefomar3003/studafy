# Secret rotation runbooks

Entry point for rotating or verifying every secret class this repo's infrastructure holds. The
inventory (what each secret is, which module creates it, its JSON keys) is
[`secrets-conventions.md`](../secrets-conventions.md) — those two docs share no duplicated content:
this directory is _procedures_, that file is _inventory and conventions_.

## The four classes

| Class             | Runbook                                                          | Rotates itself?                     |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------- |
| DB credentials    | [`rotation-db.md`](rotation-db.md)                               | Yes — AWS rotation Lambda, 30 days  |
| JWT signing keys  | [`rotation-jwt-jwks.md`](rotation-jwt-jwks.md)                   | Yes — in-process `KeyStore`, 7 days |
| Provider API keys | [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md) | No — quarterly, manual              |
| Webhook secrets   | [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md)     | No — quarterly, manual              |

## Schedule and drill

- **When**: quarterly, per [`rotation-schedule.md`](rotation-schedule.md) — calendar, ownership,
  cadence table, and the shared CloudTrail/log audit-evidence procedure.
- **How to run a quarter**: [`rotation-drill.md`](rotation-drill.md) — pre-flight, run order,
  zero-downtime gates, abort criteria, and the per-issue evidence record.
- **Calendar automation**: `.github/workflows/secrets-rotation-schedule.yml` opens the quarter's
  `secrets-rotation` issue on 1 Jan/Apr/Jul/Oct.
- **Automation primitive**: `infra/deploy/scripts/rotate-app-secret.sh` — the mechanical half of
  every application-secret rotation (Terraform apply → rolling ECS update → wait stable).

## How to read the honesty notes

Every runbook states what is actually true today, not what a rotation "should" do:

- The DB class is **single-user rotation with a documented sub-minute pooler window**; the
  dual-user swap that removes the window entirely is designed but not enabled (no per-service
  login roles exist yet).
- The JWT class rotates **entirely in process memory**; restarting the api service discards the
  outgoing key, bounded by the 15-minute access-token TTL.
- Provider keys and webhook secrets are **not yet wired into the api task definition** for keys
  that have never been rotated; the first rotation includes a one-time wiring step.
- Redis AUTH, PgBouncer's stats user, and the MariaDB/ERPNext credential have **no rotation of any
  kind** (pre-existing gaps, tracked in the schedule's status table).

The zero-downtime acceptance standard per class is stated in each runbook and scheduled in
[`rotation-schedule.md`](rotation-schedule.md); verify it during the drill, don't assume it.

## Related

- Inventory & conventions (source of truth for what exists): [`secrets-conventions.md`](../secrets-conventions.md)
- TLS certificates (ACM, auto-renewing): [`certificate-rotation.md`](../certificate-rotation.md)
- App-level token rotation (refresh-token slots) is an application behavior, not a secret rotation:
  `apps/api/src/modules/auth/services/session-store.ts`
