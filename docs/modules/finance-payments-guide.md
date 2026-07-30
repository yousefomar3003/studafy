# Finance Payments Guide (ST-121)

Recording a payment is the one place in the finance gateway where a bug costs a parent money. This
document is mostly about the machinery that prevents that.

The gateway forwards a collected payment (cash at the office, a bank transfer, a card captured
outside Studafy) to the school's ERPNext site as a submitted `Payment Entry` allocated against a
`Sales Invoice`. It holds **no financial logic** — see
[`finance-module-guide.md`](finance-module-guide.md) for the pass-through principle this inherits.

Source: [`apps/api/src/modules/finance/payments`](../../apps/api/src/modules/finance/payments) and
[`apps/api/src/modules/finance/webhooks`](../../apps/api/src/modules/finance/webhooks). The generated
contract is [`apps/api/openapi.json`](../../apps/api/openapi.json).

## Endpoints

| Method | Path                                              | Permission       | Auth   |
| ------ | ------------------------------------------------- | ---------------- | ------ |
| POST   | `/api/finance/payments`                           | `billing:update` | Bearer |
| GET    | `/api/finance/payments`                           | `billing:update` | Bearer |
| GET    | `/api/finance/payments/{paymentId}`               | `billing:read`   | Bearer |
| POST   | `/api/finance/webhooks/erpnext/payment-confirmed` | —                | HMAC   |

`paymentId` accepts either the Studafy UUID or the ERPNext Payment Entry docname
(`ACC-PAY-2026-00001`). Reads are served from `app.payment_cache` and never call ERPNext, so a
receipt still renders while ERPNext is briefly down.

`Idempotency-Key` is **required** on `POST /api/finance/payments` — see below.

## Exactly once: the three-phase forwarder

The naive implementation is wrong in a way that is easy to miss:

```
BEGIN; check key; POST to ERPNext; write cache row; COMMIT;   -- ✗
```

If the process dies after ERPNext commits its `Payment Entry` but before this transaction commits,
the idempotency reservation rolls back with everything else. The retry finds no reservation, posts
again, and ERPNext now holds two payments. **A guard that vanishes alongside the thing it was
guarding is not a guard.**

So the reservation is committed _before_ the call goes out and filled in _after_ it returns:

| Phase      | Transaction | What happens                                                                                                                 |
| ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1. Reserve | committed   | `INSERT … ON CONFLICT DO NOTHING` on `(school_id, idempotency_key)`; resolve the ERPNext client, the party, and the currency |
| 2. Forward | none        | `POST /api/resource/Payment Entry`                                                                                           |
| 3. Record  | committed   | fill in `erpnext_payment_entry_id`, insert the cache row, write the audit entry                                              |

A crash between phases 2 and 3 leaves a reserved row whose `erpnext_payment_entry_id` is `NULL`. That
state means _we do not know whether ERPNext wrote this_, and the only safe answer to a retry is to
refuse it. Reconcile from `idx_payment_cache_status`; the alternative is a silent double charge.

### What a duplicate key does

| Situation                                                                 | Answer                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------- |
| Same key, same body, earlier attempt completed                            | **200** with the original payment. No ERPNext call. |
| Same key, different body                                                  | **409 `CONFLICT_IDEMPOTENCY_KEY_MISMATCH`**         |
| Same key, earlier attempt unfinished (`erpnext_payment_entry_id IS NULL`) | **409 `PAYMENT_IN_PROGRESS`**                       |
| No key at all                                                             | **400 `PAYMENT_IDEMPOTENCY_KEY_REQUIRED`**          |

`PAYMENT_IN_PROGRESS` means _wait and re-read_. Retrying it under a **new** key is the double charge
this whole design exists to prevent.

The body is compared by `request_hash`, a SHA-256 over the request with its keys sorted, so a retry
that passed through a proxy which reserialized the JSON still hashes alike. Property order is not a
difference; an amount is.

### Release or retain, on failure

This is the decision that must not be wrong in either direction. `erpNextDefinitelyDidNotWrite`
in [`erpnext-errors.ts`](../../apps/api/src/modules/finance/erpnext-errors.ts) owns it:

| Failure                     | Proof                                               | Reservation  |
| --------------------------- | --------------------------------------------------- | ------------ |
| ERPNext 4xx (incl. 429)     | It answered by refusing. Nothing was written.       | **released** |
| Circuit open                | The breaker never sent the request.                 | **released** |
| Timeout, network error, 5xx | Unknown — it may have committed and we never heard. | **retained** |

Releasing on an unknown outcome double charges. Retaining on a definite refusal wedges the key
against a payment that never existed. 429 is grouped with the refusals deliberately: a rate limiter
rejects before handling, and retaining it would strand the key permanently.

### Two guards, not one

`/api/finance/*` was already wired to the Redis-backed
[`idempotencyMiddleware`](../../apps/api/src/middleware/idempotency.ts) before this endpoint existed.
It is kept, but it is **not** the guarantee:

- **Redis middleware** — replays a stored successful response. Fast, and **fails open**: when Redis
  is cold, evicted, or unreachable, the request passes through unguarded.
- **`app.payment_idempotency_logs`** — a unique index inside the tenant transaction. This is the
  correctness guarantee.

The middleware stores only responses below 400. That matters here: a cached 4xx would answer every
retry from Redis and the handler would never re-run, wedging the key against a payment that was
never created.

> ST-121 also fixed a bug in that middleware: it read the response body twice, and the second read —
> on an already-consumed stream — stored an empty body over the good one. Every replay returned the
> right status with no payload. It survived because the replay tests only run when Redis is reachable
> on `localhost:6390`. The regression tests now use an in-memory stand-in so they always run.

## What ERPNext owns

Everything about the money:

- the invoice's outstanding balance
- whether an amount is an overpayment, and the refusal if it is
- allocation of a payment across invoices
- the deposit account (`paid_to`, from the Mode of Payment's per-company default) and the receivable
  (`paid_from`, from the customer)

The gateway sends **no account fields**. Guessing them would put a chart-of-accounts opinion in a
service that must not hold one.

The document is submitted (`docstatus: 1`), not saved as a draft. This is load-bearing: ERPNext's
overpayment and outstanding-balance validation runs **on submit**. A draft would be accepted, settle
nothing, and hide the very rejection this endpoint exists to surface.

A rejection comes back as `application/problem+json` carrying **ERPNext's own message**, unedited:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Allocated Amount cannot be greater than outstanding amount",
  "code": "VALIDATION_FAILED",
  "request_id": "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"
}
```

## Payment modes

| Request value   | ERPNext Mode of Payment |
| --------------- | ----------------------- |
| `cash`          | `Cash`                  |
| `bank_transfer` | `Wire Transfer`         |
| `card_external` | `Credit Card`           |

These are the names ERPNext's setup wizard creates. A school that renames them in ERPNext breaks the
mapping, and the resulting "Mode of Payment not found" is forwarded rather than guessed around.

`card_external` means a card payment captured **outside** Studafy. The gateway records card payments;
it does not process cards.

A **partial** payment is simply an amount smaller than the invoice total. There is no flag and no
separate path — ERPNext decides what remains outstanding.

## Money and locale

Amounts are stored as `amount_minor bigint` with a `currency_id` FK, not `numeric(12,3)`. JOD is
seeded in migration `000005` with `minor_unit = 3` — one dinar is 1000 fils. A `numeric(12,3)` column
would hardcode that exponent and quietly divide every non-JOD currency by ten;
[`currency.ts`](../../apps/api/src/modules/finance/currency.ts) reads the real exponent from
`app.currencies` instead. `12.345 JOD` is `12345`, never `1234`.

The response carries three separate fields:

```json
{ "amount": "12.345", "amount_minor": 12345, "currency": "JOD", "currency_minor_unit": 3 }
```

They are **not** concatenated server-side. The currency code's placement relative to the number
differs between Arabic and English, so composing them here would bake one locale's word order into
the API. That composition — and the RTL rendering around it — is the client's decision.

`Accept-Language` is forwarded to ERPNext on every write, so ERPNext's own validation messages come
back translated.

## Confirmation webhook

A forwarded payment is recorded as `status: "pending"` even though ERPNext accepted the submission.
Confirmation is the webhook's to deliver, and it is also what supplies `receipt_url`. Trusting our own
read of the POST response would report money as settled before the system of record said so.

On a signed delivery the handler dedupes on `(school_id, event_id)`, then sets `status = 'confirmed'`,
stamps `confirmed_at`, stores the receipt link, and writes an audit entry with the payment entry id
and the amount in minor units.

Ordering is **authenticate, then parse**: signature verification runs in middleware ahead of the
request validator, so an unsigned caller never receives schema feedback about a payload it was not
entitled to submit. The signature covers the exact bytes ERPNext sent, which is why the handler reads
`c.req.text()` and never re-stringifies a parsed object.

A redelivery, a non-`Payment Entry` doctype, and a payload that cannot be placed against a local
student all answer **200**. The delivery was understood; answering an error would make ERPNext retry
forever. The raw document is kept in `erpnext_payload` so an unplaceable payment stays recoverable.

### One projection, two entry points

`POST /erpnext/webhooks` (the generic receiver) already mapped `Payment Entry-submitted`. Both
endpoints now call the same
[`projectPaymentEntry`](../../apps/api/src/modules/finance/payments/projection.ts).

The dedicated URL exists because payment confirmation carries an SLA the rest of the ingest does not,
and a single-purpose path can be monitored, alerted, and rate-limited on its own.

> The generic receiver's payment arm was **broken before ST-121** and could not have succeeded on any
> real payload: it passed `String(data.student_id ?? data.party ?? "")` into a `uuid` column, an ISO
> currency _code_ into the `currency_id` uuid FK, and a raw decimal `paid_amount` into the integer
> `amount_minor`. It also wrote through `db.unsafe` outside the ingestion transaction, so a projection
> could survive a rolled-back ingest. The shared function fixes all four.

Resolving `student_id` has three sources, most trustworthy first: `custom_student_id` (stamped by the
forwarder), then the referenced invoice via `app.invoice_cache`, then nothing. There is no fourth
option — `party` is an ERPNext Customer name, not a local identifier, and `payment_cache.student_id`
is a NOT NULL FK, so a guess either violates the constraint or attributes someone's money to the
wrong student.

## Secrets — no Vault, one webhook secret

ST-121 asks for per-tenant ERPNext credentials from Vault and a per-tenant webhook secret. **Neither
exists, and the code does not pretend otherwise** — the same situation ST-119 documented:

- There is no Vault. Secrets Manager is provisioned per _service_, not per tenant.
- `app.erpnext_site_configs` has no credential column, because ERPNext issues no per-tenant key here.
- Tenant separation happens at the edge: the ERPNext nginx frontend sets
  `FRAPPE_SITE_NAME_HEADER = "$host"`, so **the Host header selects the Frappe site**. One credential,
  many sites, routing by name. Payments go through the same `TenantErpNextFactory.forSchool()` as
  every other finance write.
- Webhook verification uses the global `ERPNEXT_WEBHOOK_SECRET`.

When per-tenant secrets arrive, a second `ErpNextCredentialResolver` implementation satisfies the
existing interface and no call site moves; the webhook needs only its secret lookup changed.

## Error codes

| Code                                | Status | Cause                                                             |
| ----------------------------------- | ------ | ----------------------------------------------------------------- |
| `PAYMENT_IDEMPOTENCY_KEY_REQUIRED`  | 400    | No `Idempotency-Key` header                                       |
| `VALIDATION_FAILED`                 | 400    | ERPNext rejected the payload; its message is forwarded            |
| `CONFLICT_IDEMPOTENCY_KEY_MISMATCH` | 409    | Key reused with a different body                                  |
| `PAYMENT_IN_PROGRESS`               | 409    | An earlier attempt with this key has not finished — wait, re-read |
| `PAYMENT_NOT_FOUND`                 | 404    | No such payment, or ERPNext could not find the invoice/party      |
| `RATE_LIMIT_EXCEEDED`               | 429    | ERPNext rate-limited us                                           |
| `ERPNEXT_UNAVAILABLE`               | 503    | Network failure or ERPNext 5xx                                    |
| `ERPNEXT_CIRCUIT_OPEN`              | 503    | Breaker open; requests paused while ERPNext recovers              |
| `ERPNEXT_TIMEOUT`                   | 504    | No response within the client timeout                             |

`504` is produced at runtime but **cannot be declared** in the OpenAPI document: `PROBLEM_STATUSES` in
[`openapi/responses.ts`](../../apps/api/src/openapi/responses.ts) does not include it, so it also gets
the generic `"Error"` title from `errorHandler.ts`. This is pre-existing and shared with every other
ERPNext-backed route.

## Audit

Every forward and every confirmation writes to `app.audit_logs` inside the same transaction as the
row it describes, so the two commit together or not at all.

Recorded: the ERPNext doctype and document name, the target invoice, the student, `amount_minor`, the
currency code, the payment mode, and the status.

Deliberately **not** recorded: the `Idempotency-Key` (a client credential for replay), `reference_no`
(bank data), and anything from the credential path. Audit rows are read far more widely than either
deserves.

## Schema notes

`app.payment_cache` was created by migration `000015` and, until ST-121, only ever received rows
_from_ ERPNext. Migration `000069` gives it a lifecycle rather than creating a second table —
`000015`'s own header forbids a duplicate read-model of the same document.

Added: `erpnext_invoice_id`, `payment_mode`, `status`, `receipt_url`, `idempotency_key`,
`confirmed_at`.

- `payment_mode` and `erpnext_invoice_id` are nullable — a payment Studafy did not originate knows
  neither.
- `erpnext_invoice_id` is the **requested target**, not a derived allocation. ERPNext's allocation
  across invoices remains its answer to give.
- `status` is `NOT NULL DEFAULT 'pending'`, which keeps every pre-ST-121 insert site working without
  naming the new columns.
- `ck_payment_cache_confirmed_state` is a biconditional —
  `(status = 'confirmed') = (confirmed_at IS NOT NULL)` — because a confirmed payment without a
  timestamp and a timestamped payment still reading `pending` are both incoherent.
- `text` + `CHECK` rather than `CREATE TYPE`, following `expense_cache` (`000064`). Adding a fourth
  payment mode needs a constraint swap, not the non-transactional `ALTER TYPE` migration an enum
  would force (see `000063`).

There is **no** `erpnext_payment_entry_id` column on `payment_cache`: `erpnext_docname` _is_ the
Payment Entry name, and a second column holding the same string is a second thing to keep in sync.

The backfill loops per school rather than issuing one `UPDATE`, because `tenant_isolation` is FORCED
and a single statement would match zero rows and silently no-op. It sets
`confirmed_at = GREATEST(last_synced_at, created_at)`, not `last_synced_at` alone — the webhook
receiver computes its `now` in JavaScript while `created_at` defaults to a server `CURRENT_TIMESTAMP`
a round trip later, so existing rows can carry a `last_synced_at` marginally _before_ `created_at`.

`app.payment_idempotency_logs` holds the guard. `erpnext_payment_entry_id` is nullable by design —
reserved before the POST, filled in after — the same reserve-then-confirm shape `000015` documents for
`erpnext_id_mappings.erpnext_docname`. `request_hash` is constrained to `^[0-9a-f]{64}$` so a
malformed hash cannot be stored and then silently fail to match a legitimate retry.

`studafy_app` holds `DELETE` on it, unusually for a log-shaped table, for exactly one purpose:
releasing a reservation after an ERPNext 4xx. Note that `000002`'s `ALTER DEFAULT PRIVILEGES` grants
full DML at creation, so the `REVOKE` names `studafy_app` explicitly — revoking from `PUBLIC` alone
would leave the grants standing and make the explicit `GRANT` decorative.

### Indexes

| Index                               | Serves                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| `idx_payment_idempotency_unique`    | the guard, tenant-scoped                                     |
| `idx_payment_cache_invoice_student` | "what has this student paid against this invoice?" (partial) |
| `idx_payment_cache_status`          | reconciliation: pending payments for a tenant, newest first  |

ST-121's fourth requested index — a fast webhook match on the Payment Entry id — is **deliberately not
created**. `uq_payment_cache_school_erpnext_docname` from `000015` already indexes exactly
`(school_id, erpnext_docname)`, which is the lookup the webhook performs. A duplicate is write
amplification on every payment for no additional read path. `packages/db/tests/finance.test.ts` asserts
its absence so it cannot be re-added by accident.

## Testing

| Suite                                                            | Needs                        | Covers                                                                                                                                                                         |
| ---------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/modules/finance/__tests__/payments.test.ts` (unit) | nothing                      | request hashing, ERPNext document shape, mode mapping, release/retain classification, ERPNext failure passthrough, JOD minor units, projection helpers, signature verification |
| same file (integration)                                          | `TEST_DATABASE_URL`          | the unique index admitting one reservation per key per school; reserved-vs-completed states; the lifecycle constraints                                                         |
| `packages/db/tests/finance.test.ts`                              | `TEST_DATABASE_URL`          | forced RLS and zero cross-tenant leakage on both tables, column shape, index presence and deliberate absence                                                                   |
| `apps/api/src/middleware/__tests__/idempotency.test.ts`          | nothing (in-memory stand-in) | response replay returns the original body; 4xx and 5xx are not stored                                                                                                          |

The exactly-once guarantee is verified against a real PostgreSQL rather than a fake, because the
guard _is_ a unique index plus a transaction boundary — a mock would test the mock.

```bash
docker compose -f db/compose.yml up -d
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
turbo run db:migrate
bun test apps/api/src/modules/finance packages/db/tests/finance.test.ts
```
