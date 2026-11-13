# Secret rotation runbooks

Entry point for rotating or verifying every secret class production holds. The inventory (where
each secret lives and which fly app receives it) is
[`secrets-conventions.md`](../secrets-conventions.md) — those two docs share no duplicated content:
this directory is _procedures_, that file is _inventory and conventions_.

## The four classes

| Class             | Runbook                                                          | Rotates itself?                     |
| ----------------- | ---------------------------------------------------------------- | ----------------------------------- |
| DB credentials    | [`rotation-db.md`](rotation-db.md)                               | No — manual                         |
| JWT signing keys  | [`rotation-jwt-jwks.md`](rotation-jwt-jwks.md)                   | Yes — in-process `KeyStore`, 7 days |
| Provider API keys | [`rotation-provider-api-keys.md`](rotation-provider-api-keys.md) | No — quarterly, manual              |
| Webhook secrets   | [`rotation-webhook-secrets.md`](rotation-webhook-secrets.md)     | No — quarterly, manual              |

## Schedule and drill

- **When**: quarterly, per [`rotation-schedule.md`](rotation-schedule.md) — calendar, ownership,
  cadence table, and the shared audit-evidence procedure.
- **How to run a quarter**: [`rotation-drill.md`](rotation-drill.md) — pre-flight, run order,
  zero-downtime gates, abort criteria, and the per-issue evidence record.
- **Calendar automation**: `.github/workflows/secrets-rotation-schedule.yml` opens the quarter's
  `secrets-rotation` issue on 1 Jan/Apr/Jul/Oct.
- **Mechanics**: every application-secret rotation ends the same way — change the secret in the
  `prod` GitHub Environment and rerun **Production deploy (fly.io)**, which copies it onto the fly
  apps and redeploys them ([`infra/fly/README.md#secrets`](../../../infra/fly/README.md#secrets)).

## How to read the honesty notes

Every runbook states what is actually true today, not what a rotation "should" do:

- The DB class is **a manual change of Supabase's `postgres` password**, shared by every service;
  there is no per-service login role, so no zero-window swap is possible yet.
- The JWT class rotates **entirely in process memory**; restarting the api service discards the
  outgoing key, bounded by the 15-minute access-token TTL.
- A provider key or webhook secret that is not in the deploy workflow's secret list never reaches
  fly; the first rotation of such a key includes adding it to the workflow.
- The Redis Cloud credential has **no rotation procedure** yet (tracked in the schedule's status
  table).

The zero-downtime acceptance standard per class is stated in each runbook and scheduled in
[`rotation-schedule.md`](rotation-schedule.md); verify it during the drill, don't assume it.

## Related

- Inventory & conventions (source of truth for what exists): [`secrets-conventions.md`](../secrets-conventions.md)
- TLS certificates: issued and renewed by fly (`fly certs`), see
  [`infra/fly/README.md#domains`](../../../infra/fly/README.md#domains)
- App-level token rotation (refresh-token slots) is an application behavior, not a secret rotation:
  `apps/api/src/modules/auth/services/session-store.ts`
