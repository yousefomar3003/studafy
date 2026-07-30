# Finance Reconciliation Guide (ST-122)

## Architecture Overview

The Studafy finance gateway is a **pass-through** to each school's ERPNext site. ERPNext owns:

- Fee structure templates and their validation
- Fee schedule generation and per-installment balance computation
- Sales Invoice creation and outstanding amount calculation
- Payment entry allocation and AR/GL reconciliation

The local PostgreSQL tables (`installment_cache`, `payment_cache`, `invoice_cache`) are **read-model projections** for fast UI rendering. They are never the source of truth—ERPNext is.

### Pass-Through Principle

The gateway authenticates callers, scopes requests to the tenant's ERPNext site (via Vault API keys/secrets from `EnvCredentialResolver`), applies locale/RTL + JOD presentation formatting, and forwards requests. ERPNext owns all fee schedule calculations, outstanding balances, and invoice generation.

### Single Source of Truth

ERPNext/Frappe Education Fee Schedules drive installment statuses. `installment_cache` stores local read-model projections for quick UI rendering. The daily reconciliation job ensures these projections stay accurate.

---

## Table: `installment_cache`

Per-installment read model of one ERPNext Fee Schedule entry.

| Column                     | Type               | Description                                            |
| -------------------------- | ------------------ | ------------------------------------------------------ |
| `id`                       | `uuid` PK          | Local primary key                                      |
| `school_id`                | `uuid` FK          | Tenant scope                                           |
| `erpnext_fee_schedule_id`  | `text`             | ERPNext Fee Schedule docname (1:1 per tenant)          |
| `student_id`               | `uuid` FK          | Local student reference                                |
| `fee_structure_id`         | `uuid` FK nullable | Local fee structure reference                          |
| `due_date`                 | `date`             | Installment due date                                   |
| `total_amount_minor`       | `bigint`           | Total amount in minor units (JOD has 3 decimal places) |
| `paid_amount_minor`        | `bigint`           | Amount paid so far                                     |
| `outstanding_amount_minor` | `bigint`           | Outstanding balance                                    |
| `currency_id`              | `uuid` FK          | Currency reference (JOD has `minor_unit = 3`)          |
| `status`                   | `text`             | `pending`, `partially_paid`, `paid`, `overdue`         |
| `erpnext_payload`          | `jsonb`            | Full ERPNext document for recovery                     |
| `synced_at`                | `timestamptz`      | Last synchronization timestamp                         |

### Indexes

- `idx_installment_cache_unique`: `(school_id, erpnext_fee_schedule_id)` — 1:1 mapping
- `idx_installment_cache_student`: `(school_id, student_id, due_date ASC)` — student lookup
- `idx_installment_cache_status`: `(school_id, status, due_date) WHERE status IN ('pending', 'partially_paid', 'overdue')` — reconciliation queries

### Status Transitions

```
pending ──→ partially_paid ──→ paid
  │                │
  └──→ overdue ←──┘
```

- `pending`: Not yet due, no payment recorded
- `partially_paid`: Some amount paid, balance remains
- `paid`: Fully settled (outstanding <= 0)
- `overdue`: Past due date with outstanding balance

---

## Table: `finance_reconciliation_logs`

Audit trail for daily reconciliation runs.

| Column                   | Type          | Description                                                                                         |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| `id`                     | `uuid` PK     | Local primary key                                                                                   |
| `school_id`              | `uuid` FK     | Tenant scope                                                                                        |
| `job_run_at`             | `timestamptz` | When the reconciliation run started                                                                 |
| `records_checked`        | `integer`     | Number of cache rows examined                                                                       |
| `drift_detected_count`   | `integer`     | Rows where local vs ERPNext amounts differed                                                        |
| `auto_healed_count`      | `integer`     | Drifts corrected by re-pulling from ERPNext                                                         |
| `unresolved_divergences` | `jsonb`       | Array of `{school_id, student_id, erpnext_fee_schedule_id, erpnext_outstanding, local_outstanding}` |
| `status`                 | `text`        | `success`, `drift_corrected`, `alerted_divergence`                                                  |

### Status Meanings

- `success`: No drift detected
- `drift_corrected`: All detected drifts were auto-healed successfully
- `alerted_divergence`: One or more drifts could not be resolved after re-pull

---

## Daily Reconciliation Job

### Trigger

`POST /api/finance/reconciliation/run` — authenticated via `X-Api-Key` header (service-level key, not a user bearer token). Intended to be called by an external scheduler (K8s CronJob, AWS EventBridge Scheduler) on a daily cadence.

### Execution Flow

For each school in `app.schools`:

1. **Phase 1 — Overdue Flagging**
   - Updates `installment_cache` rows where `due_date < CURRENT_DATE` and `status IN ('pending', 'partially_paid')` to `status = 'overdue'`
   - Emits `fee.installmentOverdue` domain event for each newly overdue installment

2. **Phase 2 — Drift Detection**
   - Queries every active (non-`paid`) `installment_cache` row
   - For each row, fetches the authoritative Fee Schedule document from ERPNext via `GET /api/resource/Fee Schedule/{name}`
   - Compares `outstanding_amount_minor` with ERPNext's `outstanding_amount`

3. **Phase 3 — Self-Healing**
   - If drift is detected: automatically re-pulls the DocType snapshot from ERPNext and updates the cache within the current reconciliation cycle
   - If re-pull succeeds: increments `auto_healed_count`
   - If re-pull fails or amounts still diverge: records entity IDs in `unresolved_divergences`

4. **Phase 4 — Logging & Alerting**
   - Inserts a row in `finance_reconciliation_logs` with the run's outcome
   - If unresolved divergences exist: emits `finance.reconciliationDivergence` domain event

### Drift Detection Threshold

Any difference between local `outstanding_amount_minor` and ERPNext's `outstanding_amount` (after currency minor unit conversion) is considered drift. There is no percentage tolerance: the cache must exactly match ERPNext.

---

## Self-Healing Protocol

### Re-pull Strategy

When drift is detected:

1. Re-fetch the Fee Schedule document from ERPNext
2. Update the cache row with ERPNext's authoritative amounts
3. Re-compute the status based on the new amounts and the row's `due_date`
4. Verify the update took effect by re-reading the cache row
5. If the cache still differs from ERPNext, classify as unresolved divergence

### Automatic Correction Scope

The self-healer corrects:

- `total_amount_minor`
- `paid_amount_minor`
- `outstanding_amount_minor`
- `currency_id`
- `status` (re-computed from amounts and due date)

It does NOT update:

- `student_id` (the cache entry is already scoped to the correct student)
- `fee_structure_id` (the structural relationship is immutable)
- `erpnext_fee_schedule_id` (this is the identity key)

---

## Alerting Protocol

### Unresolved Divergence Criteria

A divergence is "unresolved" when:

1. The ERPNext Fee Schedule document has an `outstanding_amount` that differs from the local cache
2. After updating the cache from ERPNext's response, the local row still does not match (possible due to a currency resolution failure, a data type mismatch, or a concurrent write)

### Alert Contents

The `finance.reconciliationDivergence` event payload contains:

- `schoolId`: The tenant UUID
- `studentId`: The student UUID affected
- `erpnextFeeScheduleId`: The ERPNext document name
- `erpnextOutstanding`: The authoritative ERPNext outstanding amount
- `localOutstanding`: The local cache outstanding amount

### Monitoring Integration Points

- **Domain events** are written to `app.outbox_events` and relayed by the outbox-relay worker
- **PagerDuty/alerting**: Subscribe to `finance.reconciliationDivergence` events for on-call notification
- **Reconciliation logs**: Query `finance_reconciliation_logs` where `status = 'alerted_divergence'` for dashboards

---

## Manual Reconciliation Procedure

If the automated reconciliation cannot resolve a divergence:

1. Query `finance_reconciliation_logs` for the affected school:

   ```sql
   SELECT * FROM app.finance_reconciliation_logs
   WHERE school_id = '<school-uuid>' AND status = 'alerted_divergence'
   ORDER BY job_run_at DESC;
   ```

2. Extract the `unresolved_divergences` JSON to identify affected student schedules

3. Verify the ERPNext Fee Schedule document directly:

   ```bash
   GET /api/resource/Fee Schedule/{erpnext_fee_schedule_id}
   ```

4. Manually update the cache via the webhook refresh or a direct SQL update (admin only):
   ```sql
   UPDATE app.installment_cache
   SET outstanding_amount_minor = <correct-value>,
       paid_amount_minor = <correct-value>,
       status = '<computed-status>',
       synced_at = CURRENT_TIMESTAMP
   WHERE school_id = '<school-uuid>'
     AND erpnext_fee_schedule_id = '<erpnext-fee-schedule-id>';
   ```

---

## Relevant Endpoints

| Method | Path                                             | Description                                |
| ------ | ------------------------------------------------ | ------------------------------------------ |
| `GET`  | `/api/finance/students/{studentId}/installments` | List student installments (from cache)     |
| `POST` | `/api/finance/fee-schedules/generate`            | Generate fee schedules in ERPNext          |
| `POST` | `/api/finance/reconciliation/run`                | Trigger daily reconciliation (service key) |

---

## Related Files

| File                                                               | Purpose                          |
| ------------------------------------------------------------------ | -------------------------------- |
| `db/migrations/000070_create_installment_cache_reconciliation.sql` | Schema definition                |
| `apps/api/src/modules/finance/installments/schemas.ts`             | Zod schemas for installments API |
| `apps/api/src/modules/finance/installments/service.ts`             | Installment read/write logic     |
| `apps/api/src/modules/finance/installments/routes.ts`              | Installment route handlers       |
| `apps/api/src/modules/finance/jobs/reconciliation.job.ts`          | Reconciliation engine            |
| `apps/api/src/modules/finance/jobs/reconciliation.routes.ts`       | Reconciliation trigger route     |
| `apps/api/src/modules/finance/__tests__/reconciliation.test.ts`    | Integration/unit tests           |
