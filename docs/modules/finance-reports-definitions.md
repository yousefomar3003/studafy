# Finance report definitions

ST-126 exposes tenant-scoped finance reports without reproducing ERPNext accounting logic. Every
request resolves the tenant's `erpnext_company_id`, binds the shared ERPNext client to the tenant's
site through the mandatory `Host` header, and fixes the ERPNext report name on the server.

## Synchronous reports

| Studafy endpoint                                       | ERPNext report                | Required filters                                                          |
| ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------- |
| `GET /api/finance/reports/ar-aging`                    | `Accounts Receivable Summary` | Tenant company, due-date aging, ranges 30/60/90                           |
| `GET /api/finance/reports/general-ledger`              | `General Ledger`              | Tenant company, `from_date`, `to_date`                                    |
| `GET /api/finance/reports/collections-vs-due`          | `Accounts Receivable`         | Tenant company, payment-term basis, future payments visible               |
| `GET /api/finance/reports/family-statement/{familyId}` | AR Summary and General Ledger | Tenant company and the distinct customer identifiers linked to the family |

Optional `student_ids` are tenant-local UUIDs. Studafy validates their ownership and translates
them to the ERPNext customer identifier currently represented by the student's admission number.
Callers cannot supply a company or report name.

Responses retain ERPNext `columns`, result rows, and `report_summary` values. Studafy adds only
presentation metadata (`en`/`ar`, `ltr`/`rtl`, `JOD`, precision `3`) and separate display strings
for currency cells. Household totals are the ERPNext AR report summary; Studafy does not calculate
aging, ledger balances, collections, or household totals.

## JoFotara artifacts

`GET /api/finance/reports/joinvoice/{invoiceId}?format=xml|json` reads the authoritative ERPNext
Sales Invoice and generates UBL 2.1 XML. JSON format contains the base64-encoded XML in the
`invoice` field. Generation requires seller, buyer, tax, currency, date, totals, and line-item data;
missing compliance data is rejected rather than synthesized.

The JoInvoice UUID is UUIDv5-derived from tenant and ERPNext invoice identity. The canonical XML
SHA-256 mapping is immutable per tenant/invoice. Repeated generation is stable; changed content
after the first mapping returns a conflict. This module generates artifacts only and never submits
them to a government endpoint.

## Asynchronous exports

`POST /api/finance/reports/export` creates a durable job and enqueues
`generate-finance-report` on `QUEUE_NAMES.REPORTS`. The `apps/workers` processor locks the
tenant-scoped row, fetches ERPNext data, uploads to
`tenant-{schoolId}/reports/{UTC-year}/{jobId}.{ext}`, and stores a 24-hour signed URL. Retries reuse
the same object key, completed jobs are idempotent, and only a generic failure is persisted on the
final attempt.

CSV output is UTF-8 with a BOM and RFC-compliant escaping. PDF output embeds Noto Sans Arabic and
applies bidirectional ordering for Arabic/mixed-direction rows. It is intended for display and uses
JOD's three-decimal convention; CSV remains the lossless representation of raw ERPNext text.
