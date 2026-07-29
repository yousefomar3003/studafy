# Finance Module Guide (ST-119)

The finance gateway is a **pass-through to ERPNext**. It carries requests to each school's ERPNext
site and answers back. It does not validate fee amounts, compute totals, decide whether a fee
category exists, or enforce currency rules — ERPNext owns all of that, and a second opinion here
would drift from the first within a release or two.

Source: [`apps/api/src/modules/finance`](../../apps/api/src/modules/finance) and the shared client at
[`apps/api/src/erpnext`](../../apps/api/src/erpnext). The generated contract is
[`apps/api/openapi.json`](../../apps/api/openapi.json); this document explains what a schema cannot.

## What the gateway owns

Three things ERPNext cannot know about:

| Concern                                                                 | Where                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| Which ERPNext site a request belongs to                                 | `client/credential-resolver.ts`, `client/tenant-client.ts` |
| The identity crosswalk between UUIDs and ERPNext document names         | `id-mappings/service.ts`, `app.erpnext_id_mappings`        |
| A local read model, so listing does not need a round trip per keystroke | `app.fee_structure_cache`                                  |

Everything else is forwarded.

## Endpoints

| Method | Path                                           | Permission       |
| ------ | ---------------------------------------------- | ---------------- |
| GET    | `/api/finance/fee-structures`                  | `billing:update` |
| POST   | `/api/finance/fee-structures`                  | `billing:update` |
| PATCH  | `/api/finance/fee-structures/{feeStructureId}` | `billing:update` |

`feeStructureId` is the **ERPNext document name** (`FS-2026-0001`), not a UUID. ERPNext names its
own documents through a naming series; the crosswalk relates those names to local ids.

`FINANCE_PERMISSIONS` already held `billing:read` and `billing:update`, so the FINANCE role gained
this surface without a permission-matrix change.

Reads are served from the cache and never call ERPNext, so a list still renders while ERPNext is
briefly down. Writes are synchronous — the Fee Structure Builder needs ERPNext's validation verdict
at submit time, which is the whole reason `app.finance_sync_outbox` is _not_ used here.

Send an `Idempotency-Key` on writes; `/api/finance/*` was already wired to the idempotency
middleware in `app.ts` before any route existed.

## Tenant routing — no per-tenant secret exists

The ST-119 ticket asks for per-tenant API key/secret pairs from Vault or Secrets Manager, keyed by
school. **That is not how this system works, and the code does not pretend otherwise.**

- There is no Vault. Secrets Manager is provisioned per _service_
  (`infra/terraform/modules/secrets`), not per tenant.
- `app.erpnext_site_configs` — filled in by provisioning — has no credential column, because
  ERPNext never issues a per-tenant key here.
- Separation happens at the edge instead: the ERPNext nginx frontend runs with
  `FRAPPE_SITE_NAME_HEADER = "$host"`, so **the Host header selects the Frappe site**. One
  credential, many sites, routed by name.

So `ErpNextCredentialResolver` resolves the _site_, and `EnvCredentialResolver` is the
implementation matching the deployed plane. The interface exists anyway because "given a school,
how do I authenticate to its ERPNext?" is exactly the question that changes if per-tenant
credentials ever arrive — a second implementation would satisfy it and no call site would move.

`TenantErpNext` wraps the raw client rather than returning it. Getting the Host header wrong does
not fail loudly; it succeeds **against the wrong tenant's data**. Wrapping means there is no code
path to ERPNext that omits it.

## Resilience

Before ST-119 there was no retry, no backoff, and no circuit breaker anywhere in this repo, and
`AbortController` appeared exactly once. All of it now lives in `erpnext/client.ts` and
`erpnext/circuit-breaker.ts`, so provisioning and bootstrap inherit it too.

### Failure classification

The client previously collapsed every non-HTTP failure — including the `AbortError` its own timeout
raised — into `status: 500`. That is a lie a retry policy cannot act on. `ErpNextError.kind` is the
fix; read it rather than inferring cause from status.

| `kind`         | Status    | Meaning                                     |
| -------------- | --------- | ------------------------------------------- |
| `timeout`      | 504       | Our own `AbortController` fired             |
| `network`      | 503       | DNS, refused, TLS, reset — no answer at all |
| `http`         | ERPNext's | ERPNext answered non-2xx                    |
| `circuit_open` | 503       | The breaker refused to call                 |

### Retry

Three attempts total, exponential backoff with **full jitter** — several API tasks that failed
against the same outage would otherwise retry in lockstep and hit the recovering site together.

Retried: `timeout`, `network`, 5xx, 429. **Never 4xx.** A 400 is ERPNext's validation verdict bound
for the builder's UI; retrying it delays the user's error message and risks double-applying a
request ERPNext had actually accepted.

### Circuit breaker

Opens after 5 consecutive failures, 30s cooldown, then a single half-open probe.

- **Keyed per school.** One tenant's site being down says nothing about another's.
- **One request is one failure**, not three. The breaker wraps the whole retry loop, so a request
  that exhausted its attempts against one outage counts once.
- **4xx does not count.** A user typing bad input must not be able to open the circuit for their
  whole school. The breaker is given the same `isTransientErpNextFailure` predicate the retry loop
  uses, so the two cannot disagree about what a failure is.
- Redis-backed when Redis is configured, so the fifth failure _anywhere_ opens the circuit
  _everywhere_ — the ECS deployment runs several tasks. Falls back to per-process state otherwise,
  and also falls back if Redis itself becomes unreachable, so losing Redis degrades the breaker
  rather than silently disabling it.

## Money

**JOD has three decimal places, not two.** It is seeded in migration `000005` with `minor_unit = 3`
— one dinar is 1000 fils. This is the single most likely bug in this module and the reason
`currency.ts` exists rather than a `* 100` at each call site: the exponent is read from
`app.currencies`, never assumed.

Amounts are stored as `total_amount_minor bigint` and returned two ways:

```json
{
  "total_amount": "1250.500",
  "total_amount_minor": 1250500,
  "currency": "JOD",
  "currency_minor_unit": 3
}
```

`total_amount` is a **string**, formatted from the integer directly. Serialising through a float is
how `12.345` becomes `12.34`, and how a large amount loses its last digits past 2^53.

The currency code is a separate field rather than concatenated into the string, because symbol
placement differs between Arabic and English and that is the client's decision.

## Version immutability

The ticket asks that updating a fee structure not disturb previously issued invoices. That is
ERPNext's own amendment behaviour: a submitted Fee Structure is immutable, and amending one creates
a new document while existing Sales Invoices keep pointing at the original.

The correct implementation here was therefore **to implement nothing**. The gateway forwards the
update and lets ERPNext refuse if the document is submitted. Working around that refusal would be
the bug.

## Localization

The caller's `Accept-Language` is forwarded to ERPNext, so ERPNext's validation messages come back
in the user's language and are returned verbatim on 4xx. On 5xx the message is replaced with a
canonical code and no upstream detail, matching the app's rule that a 5xx never carries `detail`.

## Error codes

| Code                      | Status | Cause                                                                           |
| ------------------------- | ------ | ------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`       | 400    | ERPNext rejected the request; its message is forwarded                          |
| `ERPNEXT_NOT_CONFIGURED`  | 503    | No `ERPNEXT_API_URL`/`ERPNEXT_API_KEY`, or the school's site is not provisioned |
| `ERPNEXT_UNAVAILABLE`     | 503    | Network failure or ERPNext 5xx                                                  |
| `ERPNEXT_TIMEOUT`         | 504    | No response within the client timeout                                           |
| `ERPNEXT_CIRCUIT_OPEN`    | 503    | Breaker open; requests paused while ERPNext recovers                            |
| `FEE_STRUCTURE_NOT_FOUND` | 404    | No such document                                                                |
| `RATE_LIMIT_EXCEEDED`     | 429    | ERPNext rate-limited us                                                         |

All are `application/problem+json` (RFC 9457) with `code`, `request_id`, and a localized `detail`
in `en`/`ar`.

## Secrets

The API key is a header, never a URL parameter, so it cannot leak through a logged URL. Beyond
that, error payloads are run through the audit redactor **and then scrubbed for any literal
occurrence of the key**, because ERPNext echoes request context into some error bodies — key-name
redaction alone is not enough. Nothing in the client logs `apiKey`. This has its own test that
asserts the key appears in no message, no `error.data`, and no captured log line.

## Schema notes

`app.erpnext_id_mappings` has existed since migration `000015` and, until ST-119, **nothing read or
wrote it**. Its two unique constraints make the mapping a bijection within a school, which is what
makes `upsertMapping` safely idempotent:

- `uq_erpnext_id_mappings_school_entity_studafy_id` — one ERPNext document per local entity
- `uq_erpnext_id_mappings_school_entity_docname` — one local entity per ERPNext document

Both are school-scoped on purpose: ERPNext naming series restart per site, so `FS-2026-0001`
genuinely exists in many tenants and is not a collision.

`app.fee_structure_cache` (migration `000061`) mirrors the shape of its sibling
`app.fee_schedule_cache` rather than the ticket's text — `total_amount_minor` + `currency_id` FK
instead of a float and a hardcoded `'JOD'` string, for the exponent reason above. It carries
`program_erpnext_name text` rather than a `program_id uuid`, because there is no `app.programs`
table; an ERPNext Program is an ERPNext document and a UUID column would reference nothing.

`studafy_app` holds SELECT/INSERT/UPDATE and no DELETE: a cache row is superseded by a re-sync,
never removed by the application. Note that migration `000002`'s `ALTER DEFAULT PRIVILEGES` grants
full DML at creation, so the `REVOKE` in `000061` names `studafy_app` explicitly — revoking from
`PUBLIC` alone would leave DELETE in place.

## Known gap

`Fee Structure-submitted` is mapped in `ERPNEXT_DOC_EVENT_MAP` and has a domain event, but the
webhook's `projectToCache` does not yet write `app.fee_structure_cache` for it. Today the cache is
populated by gateway writes only, so a fee structure created directly in the ERPNext UI will not
appear in a list until it is next touched through the gateway.

Closing this belongs in [`apps/api/src/erpnext/webhook.ts`](../../apps/api/src/erpnext/webhook.ts),
and it is worth doing carefully rather than by analogy with the cases beside it. `projectToCache`
runs _outside_ the handler's tenant transaction, on the raw pool via `db.unsafe`, so it has no
`app.school_id` set — and every finance cache table has forced RLS. It also passes ERPNext's
currency _code_ into `currency_id`, which is a `uuid` foreign key. Both of those want checking
before a fourth table is added to the same path.
