# Audit log data model

`app.audit_logs` is the school-owned, **append-only** record of who changed what, when, and from where.
It is monthly range-partitioned on `created_at`. The SQL rationale -- keys, the normalization review, the
JSONB payload decision, RLS and the two-layer append-only enforcement, index choices, the partition
pruning guide, and the benchmark -- is in [audit-logs-data-model](../database/audit-logs-data-model.md).
The operational runbook is
[audit-log-partition-maintenance](../database/audit-log-partition-maintenance.md).

```mermaid
erDiagram
  SCHOOLS ||--o{ USERS : "owns"
  SCHOOLS ||--o{ AUDIT_LOGS : "owns"
  USERS ||--o{ AUDIT_LOGS : "acts in (nullable: NULL = system)"

  SCHOOLS {
    uuid id PK
    text slug UK
  }
  USERS {
    uuid id PK_UK
    uuid school_id FK_UK
    text normalized_email UK
    user_status status
  }
  AUDIT_LOGS {
    uuid id PK
    timestamptz created_at PK
    uuid school_id FK_UK
    uuid actor_id FK "nullable"
    audit_action action
    text target_table
    uuid target_id
    jsonb old_values "nullable"
    jsonb new_values "nullable"
    inet client_ip "nullable"
    text user_agent "nullable"
  }
```

## Reading the diagram

**`AUDIT_LOGS` has a composite primary key, `(id, created_at)`.** PostgreSQL requires the partition key in
every unique constraint on a partitioned table, so `created_at` is part of the key rather than an ordinary
column. `id` alone is **not** enforced unique across partitions; it is the stable _logical_ audit
identifier, and consumers must treat `(id, created_at)` as the physical row identity. See
[the uniqueness limitation](../database/audit-logs-data-model.md#the-uniqueness-limitation).

**`actor_id` is nullable.** A system-initiated event -- a scheduled job, a cascade, an unauthenticated
login attempt -- has no user behind it, and a synthetic "system user" row would be a lie in `app.users`.
The foreign key is composite (`actor_id, school_id`) → `app.users (id, school_id)`, so an actor from
another school can never be attributed an action in this one. It is `MATCH SIMPLE`, so it is simply not
checked when `actor_id` is NULL -- while `school_id` stays `NOT NULL` and the tenant boundary holds.

**`target_table` / `target_id` are a polymorphic pointer, not a foreign key.** They name the row the event
concerns. There is deliberately no referential constraint: an audit row must survive the record it
describes being deleted, and the table it describes being renamed or dropped. That is the whole point of
keeping a history.

**`old_values` / `new_values` are the record states, and nothing else.** They are `jsonb` so that the log
can capture the before/after of _any_ table in the schema, each with its own independently evolving
column set. No routing or ownership column -- `school_id`, `actor_id`, `target_id`, `action` -- ever lives
inside the JSON; those are real, indexed, constrained columns, because the tenant boundary and every
query path depend on them.

**There is no `updated_at`**, unlike every other table in this schema. An append-only row can never be
updated, so the column would be a permanent lie. Its absence is the schema stating the contract.

## Access rules

| Role            | Privileges on `app.audit_logs` and every partition                      |
| --------------- | ----------------------------------------------------------------------- |
| `studafy_app`   | `SELECT`, `INSERT` — **never** `UPDATE`, `DELETE`, or `TRUNCATE`        |
| `studafy_admin` | owner; may run DDL, but **cannot** `UPDATE` or `DELETE` a row (trigger) |
| `PUBLIC`        | none                                                                    |

Tenant isolation is the canonical ST-034 policy on `school_id`, **enabled and forced** on the parent and
on every partition independently — RLS does not cascade, and `studafy_app` can name a partition directly.

Append-only is enforced twice over: by the grants above, and by `trg_audit_logs_append_only`, which raises
`42501` on any `UPDATE` or `DELETE` from **any** role including the owner. Dropping a partition is DDL, so
retention is unaffected.

## Querying

**Every audit query must carry a `created_at` range.** Partition pruning is driven by `created_at`, not by
`school_id` — so a query filtered only by school and target is correct, but probes every monthly partition
that has ever existed, and gets slower forever. See
[why every audit query needs a time range](../database/audit-logs-data-model.md#why-every-audit-query-needs-a-time-range)
for the measured `EXPLAIN` plans.

The three indexed access paths, all `school_id`-leading:

| Path                     | Predicate                                            |
| ------------------------ | ---------------------------------------------------- |
| Target investigation     | `school_id`, `target_table`, `target_id`, time range |
| Actor investigation      | `school_id`, `actor_id`, time range                  |
| Temporal school auditing | `school_id`, time range                              |
