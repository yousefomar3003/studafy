# Finance read-model, id-mapping, and sync outbox

Migration `000011_create_finance_cache_tables.sql` adds five school-owned tables under the `app`
schema: `invoice_cache`, `payment_cache`, `fee_schedule_cache`, `erpnext_id_mappings`, and
`finance_sync_outbox`. SQL constraints are the source of truth; APIs must not weaken them or treat
RLS as a substitute for permission checks.

## What owns what

ERPNext (the MariaDB plane, site-per-school; see
[ADR-0005](../adr/0005-erpnext-education-plane.md)) owns the double-entry ledger, invoice
numbering, and every balance computation. Postgres owns none of that. This migration adds no
ledger, journal entry, account, or debit/credit table, and never computes a balance locally --
`total_amount_minor`, `outstanding_amount_minor`, and `amount_minor` are cached copies of fields
ERPNext already computed, refreshed by a sync process, not derived from local entries.

Every table here is one of three kinds:

1. **Cache tables** (`invoice_cache`, `payment_cache`, `fee_schedule_cache`): denormalized
   read-models of already-submitted ERPNext documents. Each carries its own `erpnext_docname` and
   `last_synced_at`, and an `erpnext_payload jsonb` column holding the full cached document. JSONB
   is used here deliberately and only here: per the
   [normalization standard](./migration-policy.md#normalization-standard), it is for "genuinely
   flexible or external payloads," and an upstream ERPNext document is exactly that -- a schema
   Studafy does not own and cannot migrate. Promoted scalar columns exist only for fields this
   migration has a concrete, named query need for (tenant scoping, the owning student, currency,
   amount, status, and date filtering); everything else stays in the payload rather than being
   guessed at.
2. **`erpnext_id_mappings`**: the durable Studafy<->ERPNext identity crosswalk, shared by every
   synced finance entity kind (`app.finance_entity_type`: `invoice`, `payment`, `fee_schedule`). It
   outlives any single cache row -- a cache table can be truncated and rebuilt from ERPNext without
   losing identity continuity -- and can exist before the ERPNext document does:
   `erpnext_docname` starts `NULL`, reserved at outbox-enqueue time, and is filled in once ERPNext
   confirms creation and hands back a docname.
3. **`finance_sync_outbox`**: a classic transactional outbox for Studafy -> ERPNext commands (for
   example, relaying a payment captured through a Studafy-initiated online payment into ERPNext,
   since only ERPNext may write the ledger that payment settles). The same transaction that records
   the local fact also inserts the outbox row, so a worker can relay it reliably without a
   dual-write race. It carries a command payload and delivery state only -- no ledger meaning.

## Keys and functional dependencies

| Table                 | Primary and candidate keys                                                      | Principal dependencies                                                           |
| --------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `invoice_cache`       | `id`; `(school_id, erpnext_docname)`                                            | ID determines the billed student, currency, amounts, dates, status, payload.     |
| `payment_cache`       | `id`; `(school_id, erpnext_docname)`                                            | ID determines the paying student, currency, amount, date, status, payload.       |
| `fee_schedule_cache`  | `id`; `(school_id, erpnext_docname)`                                            | ID determines its optional term scope, currency, title, amount, status, payload. |
| `erpnext_id_mappings` | `id`; `(school_id, entity, studafy_id)`; `(school_id, entity, erpnext_docname)` | ID determines the crosswalk pair for one entity kind.                            |
| `finance_sync_outbox` | `id` (ordered bigint)                                                           | ID determines the queued command, its target entity, and delivery state.         |

All values are atomic; there are no arrays or repeating groups, and the one JSONB column per cache
table is a deliberate external payload, not a relational structure in disguise (1NF). No table has
a composite primary key, so 2NF is trivial. Student, currency, term, and status facts live only on
their owning table -- nothing is copied from `app.students`, `app.currencies`, `app.academic_years`,
or `app.terms` beyond the foreign key itself (3NF).

## Why `studafy_id` is not a foreign key

`erpnext_id_mappings.studafy_id` and `finance_sync_outbox.studafy_id` are intentionally
unconstrained UUID columns, not foreign keys. This is a deliberate exception to the
[normalization standard's](./migration-policy.md#normalization-standard) warning against
polymorphic foreign keys, and it is documented rather than silently done:

- The column is a crosswalk spanning multiple distinct local identity spaces (today,
  `invoice_cache.id`, `payment_cache.id`, and `fee_schedule_cache.id`, one per
  `app.finance_entity_type` value). A single physical column cannot carry three simultaneous
  foreign keys, and per-value partial foreign keys would mean three near-duplicate tables instead
  of one shared crosswalk -- exactly the repetition the ticket's DRY/KISS request rules out.
  Reusing one enum and one pair of tables across every synced entity kind is the point.
- A trigger that dispatches on `entity` and checks existence in the right table was considered and
  rejected: it does not close a real correctness gap. A mapping or outbox row is written to
  _reserve_ identity before the corresponding cache row necessarily exists (see below), so requiring
  the cache row up front would break the exact ordering the outbox pattern needs. A momentarily
  orphaned crosswalk row is harmless -- the next successful sync corrects it -- and application code
  must always resolve identity through this table rather than assume a row exists on the other side.

## Cache versus identity: why two layers

`invoice_cache` (and its siblings) already carry their own `erpnext_docname`, so on first glance
`erpnext_id_mappings` looks redundant. It is not, for one concrete reason: caches are disposable and
identity is not. A cache row can be evicted, reset, or rebuilt wholesale from ERPNext at any time
without losing the ability to answer "what is this school's Studafy id for ERPNext docname X" (or
the reverse) -- because that answer lives in `erpnext_id_mappings`, independent of whether a cache
row currently exists. The same table also lets the outbox reserve a `studafy_id` for an
about-to-be-created ERPNext document (`erpnext_docname IS NULL` until ERPNext confirms), which a
cache table cannot do, since a cache row only ever represents a document ERPNext has already
submitted.

## RLS and grants

All five tables are owned by `studafy_admin`, grant only CRUD to `studafy_app`, revoke table/type
access from `PUBLIC`, and carry the canonical permissive `FOR ALL TO PUBLIC` `tenant_isolation`
policy (`app.apply_tenant_isolation`) with both RLS flags enabled and forced -- this repo's uniform
treatment for every tenant-scoped table, not only the three literally named "cache" tables in the
acceptance criteria. There is no `BYPASSRLS` role anywhere in this schema
(`db/migrations/000002_create_database_roles_and_grants.sql`), so a background sync/outbox worker
processes one school at a time, setting `app.school_id` before each tenant's batch, the same way
every other tenant-scoped read or write in this codebase must.

## Index rationale

Constraint indexes cover tenant-scoped docname lookup on every cache table and both crosswalk
directions on `erpnext_id_mappings`. Additional indexes are limited to a concrete, named need:

- `idx_invoice_cache_school_student_id`, `idx_payment_cache_school_student_id`: list a student's
  invoices/payments; back the composite student foreign key.
- `idx_invoice_cache_school_currency_id`, `idx_payment_cache_school_currency_id`,
  `idx_fee_schedule_cache_school_currency_id`: back the currency foreign key's parent update/delete
  check, matching the precedent set by `idx_schools_default_currency_id` in `000004`.
- `idx_invoice_cache_school_due_date` (partial, `WHERE due_date IS NOT NULL`),
  `idx_payment_cache_school_payment_date`: the canonical billing-dashboard query shape this cache
  layer exists for -- "what is due soon" / "what was paid recently" -- ordered fast reads without a
  join.
- `idx_fee_schedule_cache_school_academic_year_id`, `idx_fee_schedule_cache_school_term_id`: back
  the optional composite term/year foreign keys.
- `idx_finance_sync_outbox_school_status_available` (partial, `WHERE status IN ('pending',
'processing')`): the outbox worker's own polling query -- the next eligible rows for one tenant.
- `idx_finance_sync_outbox_school_entity_studafy_id`: idempotency and inspection -- "does this
  entity already have a queued outbox row."

All tenant indexes lead with `school_id`; the RLS policy still casts the GUC rather than relying on
the indexed column. There are no status-only, docname-only, or other speculative indexes.

## Known gaps

Not built here, and deliberately out of scope for this migration:

- No payment-to-invoice allocation. ERPNext payments may settle multiple invoices or none yet;
  reconstructing that allocation locally would be the local ledger this migration must not build.
  `payment_cache` stores a payment's own total only.
- No inbound/outbound direction column on `finance_sync_outbox`. It models outbound
  Studafy-to-ERPNext commands only; inbound refresh of the cache tables from ERPNext is a separate
  ingestion/webhook concern, not the transactional-outbox problem this table solves.
- No retry/backoff policy is encoded beyond `attempts`, `available_at`, and `last_error` as plain
  data. Backoff scheduling (how `available_at` advances after a failure) is worker logic, not a
  database constraint.
- No student/teacher <-> ERPNext party mapping (e.g. Customer/Employee linkage). The ticket names
  invoice, payment, and fee schedule only; this repo has no confirmed Frappe Education party model
  to build against, so `app.finance_entity_type` is scoped to exactly those three rather than
  guessing at ERPNext's internal doctype linkage.
