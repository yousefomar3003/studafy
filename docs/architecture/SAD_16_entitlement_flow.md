# Entitlement flow (SAD §16)

How a Stripe subscription change becomes an entitlement decision, and why each step is where it is.

## An assumption this document is built on

ST-133 cites **SAD section 16** as the source of this flow. The SAD is not in this repository —
`docs/architecture/SAD_21_notification_dispatch_flow.md` records the same gap for section 21,
`docs/architecture/SAD_28_logging_conventions.md` for section 28, and
`db/migrations/000018_create_partitioned_audit_logs.sql` for section 15. The design below is
therefore taken from the ticket's own stated requirements and from what the schema and the existing
workers already establish. **This document does not claim that the unavailable SAD text was
inspected.** If the SAD later contradicts it, a follow-up ticket reconciles the two.

Three parts of the ticket describe a system that did not exist here. Each is called out at the point
where this implementation diverges, with the reason.

## The problem this closes

`apps/api/src/middleware/tenant-lifecycle.ts` enforces the entire subscription lifecycle state
machine from the access token's `subscription_status` claim, with — by design — zero database calls
per request. Until ST-133 the companion `entitlements_ver` claim was hardcoded to `1` at both signing
sites, a gap `SAD_13_session_model.md` records explicitly. A school that Stripe canceled therefore
kept full access for as long as its outstanding tokens lived: up to `JWT_ACCESS_TTL_SECONDS`, 15
minutes.

## The path

```
  Stripe: customer.subscription.deleted
            │
            ▼
  POST /api/subscriptions/webhook/stripe    signature verified over raw bytes
            │
            ▼
  handleStripeWebhook  ──▶ withSystemTx ─── ONE transaction ──────────────────────┐
            │                                                                     │
            ├─ claimEvent            app.billing_events   (dedupe on provider id)  │
            ├─ setTenantScope        arms app.school_id                            │
            ├─ resolveTarget         school | ai + studentId                       │
            ├─ foldStatus            the state machine's verdict                   │
            │                                                                      │
            ├─ UPDATE app.subscriptions / app.ai_subscriptions                      │
            ├─ emitAudit          ──▶ app.audit_logs                                │
            ├─ publishEntitlementChange ─┬──▶ app.entitlement_versions  (bump)      │
            │                            └──▶ app.outbox_events         (emit)      │
            │                                                                       │
            └─ cascadeToAiSubscriptions ── one bump + one event per affected student │
                                                                                    │
   all six writes commit together, or none do ───────────────────────────────────────┘
            │
            ▼  after COMMIT
  app.outbox_events                    subscription.statusChanged
                                       aiSubscription.statusChanged
            │
            ├──▶ outbox-relay worker ──▶ Redis pub/sub `events:{school}:{event}`
            │         │                            │
            │         │                            ▼
            │         │                 entitlement-invalidation.subscriber  (apps/api)
            │         │                            │   fast, lossy
            │         │                            ▼
            │         │                 INVALIDATE_TO_FLOOR (Lua, version-guarded)
            │         │
            └──▶ entitlement invalidator (apps/workers)   ── the durable guarantee
                      │  claim ─ invalidate ─ mark, one transaction
                      ▼
              ent:{schoolId} := "<version>|"        ← body dropped, version kept
              ent:ai:{studentId} := "<version>|"
                      │
                      ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  EntitlementService                                                 │
  │    school(id) / ai(id, student)  → cache hit, or singleFlight →     │
  │                                    one join query → SET_IF_NEWER    │
  │    currentVersion(id)            → one GET; a floor answers it      │
  └─────────────────────────────────────────────────────────────────────┘
                      │                                  │
                      ▼                                  ▼
        jwtAuthMiddleware step 4              route-level entitlement checks
        claim < current → 401                 (ST-155 consumes this)
        AUTH_ENTITLEMENTS_STALE
                      │
                      ▼
        client → POST /api/auth/refresh → readSessionClaims → new token at the current version
```

Sources: [webhook-processor.ts](../../apps/api/src/modules/subscriptions/stripe/webhook-processor.ts) ·
[process.ts](../../packages/billing/src/process.ts) ·
[entitlement-change-publisher.ts](../../apps/api/src/modules/subscriptions/entitlements/entitlement-change-publisher.ts) ·
[resolve.ts](../../apps/api/src/modules/subscriptions/entitlements/resolve.ts) ·
[cache.ts](../../apps/api/src/modules/subscriptions/entitlements/cache.ts) ·
[service.ts](../../apps/api/src/modules/subscriptions/entitlements/service.ts) ·
[invalidator.ts](../../apps/workers/src/queues/entitlements/invalidator.ts) ·
[jwtAuth.ts](../../apps/api/src/middleware/jwtAuth.ts) ·
[000080](../../db/migrations/000080_create_entitlement_versions.sql)

## Why the version bump rides the webhook transaction but the cache write does not

The ticket asks for the version bump to happen in the _consumer's_ transaction, not the webhook's,
so the two modules stay independently deployable.

> **Divergence.** The bump is in the webhook's transaction; only the _cache invalidation_ is in the
> consumer's. The reason is atomicity: a version that could commit separately from the status change
> it describes can be observed out of order, and a token minted in that window would carry a version
> below the committed state and be rejected for a change that had not happened. Keeping the bump
> beside the `UPDATE` makes "the version always describes a persisted status" a property of the
> schema rather than of timing.
>
> The decoupling the ticket actually wanted is preserved in full: the webhook processor still has no
> knowledge of the entitlement module. It calls an injected `EntitlementChangePublisher` port —
> structurally identical to the `BillingAuditWriter` port ST-132 already established — and
> `packages/billing` contains no `apps/api` import. The cache, which is the part that can fail
> independently and be retried, is written by the consumer.

## Why the events had to be created

> **Divergence.** The ticket says to consume the domain events ST-132 emits. ST-132 emits none —
> there is no `emit()` call in the webhook processor or in `packages/billing`, and `DOMAIN_EVENTS`
> had no `subscription.*` key. Both events are new work in ST-133.
>
> Their names are two segments, not three, because
> `db/migrations/000022_create_outbox_events_table.sql` CHECKs
> `event_name ~ '^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$'`. A `subscription.status.changed` would be
> rejected at INSERT time — inside the very webhook transaction recording the change.
> `packages/constants/src/events.test.ts` asserts the shape of every name for this reason.

## Why there are two consumers

> **Divergence.** The ticket names the outbox relay's pub/sub as the invalidation path. That path was
> inert in production: the relay started only when `env.SCHOOL_IDS` was non-empty, and that variable
> is absent from the ECS task definition — a gap
> `apps/api/src/modules/grades/enqueue-dispatch.ts` had already documented. Shipping only the
> pub/sub subscriber would have shipped dead code and an unmeetable SLA.
>
> Three things ship instead. The relay now discovers schools from `app.schools` when `SCHOOL_IDS` is
> unset, and re-reads them each cycle, so it runs and a newly registered school no longer waits for a
> worker restart. The pub/sub subscriber ships as specified and is the sub-100ms happy path. And a
> durable poller in `apps/workers` — modelled on the email dispatcher, the one consumer style in this
> repo that demonstrably runs in production — carries the actual guarantee, because Redis pub/sub is
> fire-and-forget and an API pod restarting mid-deploy would otherwise lose the message until the TTL.
>
> Running both is safe by construction, not by luck: both apply the same version-guarded Lua, so
> whichever arrives second returns 0 and changes nothing.

## The cache encoding, and why invalidation is not a DELETE

Entries are `<version>|<json>`. Invalidation replaces the body with nothing, leaving `<version>|`.

A plain DELETE has the classic stale-set race: a reader that queried the database _before_ the
webhook committed can `SET` its now-stale value _after_ the invalidation, pinning a wrong entitlement
for the full 300s TTL. Both writes are therefore compare-and-set inside Lua — the same technique
already shipped in `modules/grades/published/cache.ts`. A racing reader holding an older version
fails the CAS; it still answers its own request correctly, but cannot pollute the cache.

Keeping the version after invalidation also means `currentVersion()` — the only thing the JWT
middleware needs — is answered by the floor marker immediately, with no Postgres round trip and no
wait for anyone to re-resolve.

## The school-inactive rule is structural

`AI active` is a boolean AND over one joined row, not two lookups:

```sql
COALESCE(s.status::text = ANY($LIVE) AND ai.status::text = ANY($LIVE), false) AS ai_active
```

Two independent lookups could disagree — an AI verdict computed from `ai_subscriptions.status` alone
reads `active` for a student whose school was canceled moments ago, and no ordering between two
queries closes that. `tests/entitlements/resolution.test.ts` asserts the case directly by writing an
`active` AI row under a `canceled` school, with no cascade to move it.

`ent:ai:{studentId}` is not school-prefixed, so a school change cannot find its students' entries.
The AI entry therefore carries the `schoolVersion` it was computed against, and the reader treats a
mismatch as a miss. This is what covers the case no AI event exists for: a school leaving a live
state that cascades zero AI rows still changes the effective AI answer.

## What does not exist

- **No usage metering or quota decrement.** This service resolves ceilings. `quotas.studentCap` comes
  from `app.subscriptions.student_cap`, the only ceiling this schema has — `app.plans` is pure
  metadata with no tier or limit columns, and no per-plan quota table was invented. Per-request
  consumption is ST-155.
- **`checkStudentCap` is not behind this cache**, and must not be moved behind it: it counts enrolled
  students inside the write transaction and must see that transaction's own snapshot. A cached
  ceiling with an uncached count is a cap that can be raced past.
- **No grace or dunning transitions.** `LIVE_STATUSES` already includes `grace_period`; ST-134 owns
  the transitions and this flow only reacts to whatever state the tables end up in.
- **Role changes do not bump the version.** `AccessTokenClaims.entitlements_ver` was documented as
  covering "roles or permissions"; ST-133 bumps it for subscription changes only, and the doc comment
  now says so. Closing that gap — either by bumping on role assignment or by adding a
  `subject_type='user'` — is a follow-up.
- **Stampede protection is per-process.** `singleFlight` is an in-memory Map, not a Redis lock, so a
  cold key costs one resolution per pod rather than one per cluster. Deliberate: the resolver is a
  single indexed row read, and a distributed lock would put two extra round trips and a lock-expiry
  failure mode on the authentication hot path.
- **Both outbox consumers are O(#schools) per cycle**, because `app.outbox_events` is tenant-isolated
  and its policy reads `app.school_id` without `missing_ok`, so a cross-tenant claim is not
  expressible. The email dispatcher has the same ceiling. A tenant-agnostic claim path is its own
  ticket.

## Verifying

```bash
bun run db:up && bun run db:migrate
bun run db:test:rls-coverage
bun run db:migrate:validate

cd apps/api  && bun test ./tests/entitlements ./tests/auth/entitlement-staleness.test.ts \
                        ./src/modules/subscriptions/__tests__ --timeout 120000
cd apps/workers && bun test ./src/queues/entitlements --timeout 120000

bunx turbo run lint check-types test build --filter=!@studafy/mobile
```

The three acceptance criteria map to specific suites:

| Criterion                                      | Suite                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Change reflected in decisions within 5 seconds | `apps/api/tests/entitlements/propagation.test.ts` (polls, no sleeps) |
| A stale JWT is forced to refresh               | `apps/api/tests/auth/entitlement-staleness.test.ts`                  |
| Cache is stampede-safe under cold-key load     | `apps/api/tests/entitlements/stampede.test.ts`                       |
