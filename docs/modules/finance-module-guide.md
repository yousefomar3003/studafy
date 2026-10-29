# Finance Module Guide (ST-119)

The finance gateway is a **pass-through to ERPNext**. It carries requests to each school's ERPNext
site and answers back. It does not validate fee amounts, compute totals, decide whether a fee
category exists, or enforce currency rules — ERPNext owns all of that, and a second opinion here
would drift from the first within a release or two.

Source: [`apps/api/src/modules/finance`](../../apps/api/src/modules/finance) and the shared client at
[`apps/api/src/erpnext`](../../apps/api/src/erpnext). The generated contract is
[`apps/api/openapi.json`](../../apps/api/openapi.json); this document explains what a schema cannot.

**Payments have their own guide:** [`finance-payments-guide.md`](finance-payments-guide.md) (ST-121)
covers `POST /api/finance/payments`, the three-phase idempotency protocol that makes a payment post
exactly once, and the ERPNext confirmation webhook. Read it before touching anything that forwards
money.

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

| Code                                | Status | Cause                                                                                   |
| ----------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`                 | 400    | ERPNext rejected the request; its message is forwarded                                  |
| `ERPNEXT_NOT_CONFIGURED`            | 503    | No `ERPNEXT_API_URL`/`ERPNEXT_API_KEY`, or the school's site is not provisioned         |
| `ERPNEXT_UNAVAILABLE`               | 503    | Network failure or ERPNext 5xx                                                          |
| `ERPNEXT_TIMEOUT`                   | 504    | No response within the client timeout                                                   |
| `ERPNEXT_CIRCUIT_OPEN`              | 503    | Breaker open; requests paused while ERPNext recovers                                    |
| `FEE_STRUCTURE_NOT_FOUND`           | 404    | No such document                                                                        |
| `FAMILY_NOT_FOUND`                  | 404    | No such family in this school                                                           |
| `FAMILY_PAYMENT_EXCEEDS_BALANCE`    | 400    | A family payment is larger than what the family owes in that currency                   |
| `FAMILY_PAYMENT_ALLOCATION_INVALID` | 400    | A family payment split names another family's invoice, overpays one, or does not add up |
| `RATE_LIMIT_EXCEEDED`               | 429    | ERPNext rate-limited us                                                                 |

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

**ST-121 fixed exactly these two defects for the payment arm, and that arm is now the pattern to
follow.** `erpnext.paymentReceived` delegates to
[`projectPaymentEntry`](../../apps/api/src/modules/finance/payments/projection.ts), which takes a
`tx` and runs inside `withTenantTx`, resolves the currency through `app.currencies` before touching
`currency_id`, converts the decimal amount with the currency's own exponent, and resolves
`student_id` to a real UUID rather than casting an ERPNext party name. The invoice, credit-note, and
fee-schedule arms beside it still carry the original bugs — they pass currency codes and ERPNext
party names into `uuid` columns and raw decimals into `*_minor` columns, and none of them can
succeed on a real payload. Each wants the same treatment.

## Running against a real ERPNext

Exercised end to end against the pinned ERPNext + Education image (`bun run erpnext:up` and
`bun run erpnext:site`): fee reports, invoices, payments, scholarship awards, the ERPNext webhooks and
the daily reconciliation all work. What each school's site needs is set up by
`infra/deploy/erpnext/seed/provision.py` (via `erpnext-new-site.sh` in staging/prod):

- **Webhooks.** One Frappe Webhook per projected doctype (Sales Invoice, Payment Entry, Fee
  Schedule, Fee Structure) posts submitted documents to `POST /erpnext/webhooks`, with the school id
  stamped into the body and signed with `ERPNEXT_WEBHOOK_SECRET` (Frappe's base64
  `X-Frappe-Webhook-Signature`; the API also accepts the hex `X-ERPNext-Signature`).
- **Reconciliation.** `POST /api/finance/reconciliation/run` is called daily at 02:30 UTC by the
  workers (`queues/billing/finance-reconciliation.ts`) with `RECONCILIATION_API_KEY`.

### Scholarships

Scholarships are Studafy's own data (000149: `app.scholarships`, `app.scholarship_awards`), not an
ERPNext doctype; the earlier design that recorded confirmed awards in a custom "Scholarship Award"
doctype (000066) is retired and its tables are no longer read. Finance (`billing:update`) creates
scholarships and requests awards under `/api/finance/scholarships` and
`/api/finance/scholarship-awards`; only the school admin (`billing:approveScholarship`, ORG_ADMIN)
approves, rejects or revokes them.

ERPNext sees a scholarship only as the Sales Invoice's own discount: when the billing worker generates
an invoice it totals the student's approved awards of active scholarships
(`queues/billing/scholarship-discount.ts`) and posts that as `discount_amount` with
`apply_discount_on: "Net Total"`, so ERPNext's grand total, ledger and outstanding amount include it.
Approving or revoking an award never touches an issued invoice.

FINANCE holds no `student:read`, and `app.students`' role-scope policy hides every student from it,
so award reads and the student picker run through `withStudentIdentityTx`: `studafy_admin` with tenant
isolation armed, selecting identity columns (name, admission number) only.

### Sibling discount

A school-wide rule (000151: `app.sibling_discount_settings`, `app.sibling_discount_tiers`) discounts
a family's second and later enrolled children without an award per child. Siblings are enrolled
students sharing a family through `app.parent_child_links`, ranked eldest first by date of birth
(`packages/billing/src/sibling-discount.ts`, shared by the API and the workers). A tier applies from
its child position upward until a higher tier takes over: `{2: 10%, 3: 15%}` is "second child 10%,
third and later 15%". A child in two families takes the better position.

The billing worker adds the child's tier to their approved scholarships when it generates an invoice;
both go through `scholarshipDiscountMinor`, so they add up and are capped at the invoice subtotal.
`GET /api/finance/sibling-discount` is `billing:read`; `PUT` is `billing:approveScholarship`, the same
sign-off an award needs. Issued invoices never change.

### Families

`/api/finance/families` is the household as finance sees it (`modules/finance/family-accounts`):
guardians, children with their sibling ranking and discount, and per-currency billed, outstanding and
overdue totals across the children's invoices (drafts and cancelled excluded, currencies never
summed). `.../{familyId}/profile` adds the family's message history. Both are `billing:read` and run
through `withStudentIdentityTx`; so does the household view `GET /api/finance/families/{familyId}`
and the family statement report when the caller is staff, which FINANCE could not open before.

`POST /api/finance/families/{familyId}/payments` (`billing:update`, `Idempotency-Key` required)
records one payment across the children's invoices: oldest due first, or a split the caller gives,
validated against what each invoice owes. Each share is posted through `createPayment` under a key
derived from the family key and the invoice, so a retry after a `partial` outcome pays only what is
left. An amount above the family's balance is refused (`FAMILY_PAYMENT_EXCEEDS_BALANCE`) rather than
becoming an unallocated advance.

### How parents and children get linked

A family is a group of `app.parent_child_links` rows, so everything family-based in finance starts
with a link. Staff make every link by picking both people themselves. Studafy never matches or links
anyone by name, email, phone, record data or any ID number, the CSV import included. Studafy never
asks for government ID itself. A school may collect it on its own record templates
([student-records.md](student-records.md)), and it is then handled as sensitive data and never used
to find anyone. Every link made on screen goes through `linkParentToStudent`
(`modules/users/student-service.ts`). That function checks both people are in the school and that
the parent has the PARENT role, puts the link in a family through `resolveGuardianFamily` (a chosen
family, else the parent's oldest one, else a new one named after the parent), and writes an
`insert` audit row on `parent_child_links`. There are five ways in:

| Where                                                                | Call                                       | Needs                            |
| -------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| Admin > Students > New student, "Guardians (optional)"               | `POST /api/students` with `guardians`      | `student:create` + `parent:link` |
| Admin > Users > New user, role Parent, "Link children (optional)"    | `POST /api/users` with `children`          | `user:create` + `parent:link`    |
| A student's profile > Guardians tab > Add guardian                   | `POST /api/students/{studentId}/guardians` | `student:update`                 |
| Finance > Unlinked > a parent's "Link children" (one call per child) | `POST /api/students/{studentId}/guardians` | `student:update`                 |
| Admin > Students > Import, a row naming a **new** parent email       | the import worker (`queues/imports`)       | `student:import`                 |

**The CSV import never matches by email.** A row's `parent_email` is used only to create a new
parent. If it already belongs to any account in the school, the row is a `PARENT_ACCOUNT_EXISTS`
parent conflict: the student is still imported, with no link, and the preview tells staff to link
the parent from the student's Guardians tab or Finance > Unlinked. A new `parent_email` creates a new
PARENT account and household. Rows in the same file that share one new `parent_email` are siblings:
the first creates the parent and household, the others are linked to the same parent, and the
preview shows that grouping before confirm. The match is within that one uploaded file, never against
existing people. The import writes its own `insert` audit rows on `users`, `families` and
`parent_child_links`.

Linking while creating runs in the creating transaction. A guardian or child that cannot be linked
(not a PARENT, not in this school, listed twice) fails the whole request, and nothing is created.
Creating a person and linking them are separate powers. A caller holding `user:create` or
`student:create` without `parent:link` gets 403 for a request that carries links, and the web hides
the link step from them. Today every role that can create people also holds `parent:link`, so this
check is a guardrail and not a change of behavior. `/api/families/{familyId}/links` (`parent:link`)
stays the way to move a link between households.

**What happens to an unlinked student.** An enrolled student no guardian is linked to belongs to no
family. The sibling discount does not count them or apply to them. They appear in no family account,
statement, reminder or family payment. Their invoices carry `family_id: null`. No parent can see
their fees, pay them online (`finance/online-payments` accepts a linked parent or staff), or receive
their receipts and fee notices. Their invoices are still generated and payable at the desk, and once
a guardian is linked the next invoice counts the student as a sibling. Issued invoices never change.

**Where the school finds them.**

- **Finance > Families** shows a count of unlinked students and parents above the list, linking to
  Finance > Unlinked (`/portal/finance/unlinked`).
- **Finance > Unlinked** lists both groups, searchable and paginated:
  `GET /api/finance/unlinked/students` (enrolled students with no link),
  `GET /api/finance/unlinked/parents` (PARENT accounts, archived ones excluded, with no link) and
  `GET /api/finance/unlinked/summary` (the counts). They are gated on `billing:read`, like the
  families list whose gap they show, and they run through `withStudentIdentityTx` (identity columns
  only), so FINANCE can see who is missing even though it cannot read student records. A student row
  opens the student's Guardians tab (`?tab=guardians`), and a parent row opens a picker for their
  children. Both fixes need `student:update`, which finance does not hold, so finance sees a note to
  ask a school admin instead.
- **Generate invoices** first calls `POST /api/finance/invoices/batches/preflight` with the batch's
  targets. It resolves the same students the batch would bill and creates nothing. If any of them
  have no family, finance sees how many, who (the first 100 by name) and why it matters before
  confirming. This is a warning, not a block: "Generate anyway" starts the batch as it is.

### Fee notices to guardians

Four notification types (000152) reach a student's guardians, written straight into
`app.notifications` like announcements and messages:

| Type                   | Sent when                                                                         |
| ---------------------- | --------------------------------------------------------------------------------- |
| `FEE_INVOICE_ISSUED`   | ERPNext's Sales Invoice webhook projects a submitted invoice that owes money      |
| `FEE_PAYMENT_RECEIVED` | a Payment Entry is confirmed (either webhook)                                     |
| `FEE_PAYMENT_REMINDER` | finance reminds a family, or all overdue families (`POST /api/finance/reminders`) |
| `FEE_STATEMENT`        | finance sends a family its statement                                              |

`app.finance_communications` (000153) logs every send per guardian. Its partial unique index keeps an
automatic notice to one per document, however often ERPNext redelivers; it enforces a 24-hour
reminder cooldown per family; and it records sends to a guardian who has turned the type off
(`delivered = false`), so the family page can say so.

### Receipts

`GET /api/finance/payments/{paymentId}/receipt` renders a PDF from the payment cache
(`modules/finance/receipts`), in the request's language. Finance staff can read any receipt, a
guardian only their own children's; anyone else gets a 404. `receipt_url` in payment responses now
points here (`/api/...`, relative to the API origin) once a payment is confirmed. ERPNext's own print
view needs its PDF renderer to resolve the site's hostname from inside the container, and a parent
cannot authenticate to ERPNext. Arabic is drawn as fontkit-shaped glyph outlines: pdf-lib can neither
embed the WOFF font nor place the dots Noto Sans Arabic positions as separate marks.

### Payments and webhooks over REST

- A Payment Entry created over REST does not run ERPNext's form logic, so `buildPaymentEntryPayload`
  sends `source_exchange_rate`/`target_exchange_rate` of 1 and `paid_to`, the deposit account ERPNext
  itself configures for the Mode of Payment and the invoice's company (`get_bank_cash_account`). A
  mode without a default account is refused with ERPNext's own message.
- ERPNext lowers an invoice's outstanding amount without firing a document event when a payment is
  submitted, so both payment webhooks re-read the settled invoices (`invoices/refresh.ts`).
- `upsertMapping` keeps an existing mapping for a document. The billing worker maps a generated
  invoice under its idempotency key, and the projection's second mapping used to fail the Sales
  Invoice webhook on every redelivery.
- Frappe's nested error messages (`_server_messages`, `exception`) are unwrapped into plain text.

### Expenses

An expense is posted as a Purchase Invoice (a supplier bill) or a Journal Entry. There is no
`expense_claim` type: ERPNext's Expense Claim lives in the separate HRMS app, which the erpnext image
does not install (it would add payroll, leave and attendance to every school's site).
