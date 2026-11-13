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

- There is no Vault. Secrets are held per _service_ (the `prod` GitHub Environment, copied to each
  fly app; `infra/fly/README.md`), not per tenant.
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

| `kind`                                       | Status                                                                                              | Meaning                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `timeout`                                    | 504                                                                                                 | Our own `AbortController` fired             |
| `network`                                    | 503                                                                                                 | DNS, refused, TLS, reset — no answer at all |
| `http`                                       | ERPNext's                                                                                           | ERPNext answered                            | What happens |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 4xx, or the circuit was open (nothing sent)  | Refusal: back to `pending_approval`, ERPNext's error returned                                       |
| Timeout, connection lost, 5xx                | Ambiguous: ERPNext is asked once (tagged return against the invoice; the cancelled doc's docstatus) |
| … and it has the write                       | Recorded as a success                                                                               |
| … and it does not                            | Back to `pending_approval`, the error returned                                                      |
| … and it cannot be asked                     | Stays `approved` (never re-postable), reported to Sentry and the log, 503 to the caller             |
| 2xx for a credit note but no document name   | Recorded if the lookup finds it; otherwise stays `approved` and is reported (it was accepted)       |

A request left `approved` for more than 15 minutes is settled by the same lookup, never by posting:
by the daily finance reconciliation (`POST /api/finance/reconciliation/run`, up to 20 per school
per run, one short query per school when none are stuck), or at once when someone approves it again.

### Payment plans

`POST /api/finance/fee-schedules/generate` (`billing:update`) splits a submitted fee structure into
installments for the students saved on it; ERPNext divides the total by `schedule_type` over the
due dates. The web's Fees page offers it per structure. Installments show on the student's account
(`/portal/finance/students/:studentId`), the overdue list and the dashboard tiles.

### Sales tax (VAT)

Off by default (`app.school_tax_settings`, `app.school_tax_exempt_categories`, migration 000178).
Whether a fee is taxable is the school's legal call (UAE zero-rates core tuition; Saudi Arabia taxes
private schooling for non-citizens), so saving needs `organization:manageSettings`. When on, the
billing worker (`sales-tax.ts`) adds one "On Net Total" tax row on the school's ERPNext tax account
to each invoice it generates, after scholarship and sibling discounts, and zero-rates exempt fee
categories through each line's `item_tax_rate`. `prices_include_tax` marks the row
`included_in_print_rate`. Issued invoices never change. The registration number prints on the
invoice detail and the payment receipt.

### Collections by method

`GET /api/finance/reports/collections-by-method` groups confirmed payments by day, currency and
method from `payment_cache`, one indexed query and no ERPNext call, so the daily cash-up works
while ERPNext is down. Reversed and pending payments are not counted. The payments list's `totals`
gives the same figure for any filter.

### Finance reads and row-level security

FINANCE holds `billing:read` but not `student:read`, so `app.students` is invisible to it under its
own RLS. Every finance read that joins a student's name runs through `withStudentIdentityTx`
(identity columns only, tenant-scoped). The invoice list, invoice detail and batch items did not,
and returned nothing to FINANCE until this was fixed.
