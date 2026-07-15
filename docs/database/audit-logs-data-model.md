# Audit log data model

`app.audit_logs` (ST-046) is the school-owned, append-only record of who changed what, when, and from
where. It is monthly range-partitioned on `created_at`. The operational runbook is
[audit log partition maintenance](audit-log-partition-maintenance.md).

## Stated assumption on the schema shape

The ST-046 ticket cites **SAD section 15** as the source of this table's shape. **The SAD is not in this
repository** — `docs/api/global-data-erd.md` records the same gap for section 10. The column list below
is therefore taken from the ticket's own normalization requirements rather than inferred from a document
nobody here can read, and the assumption is repeated in the migration header. If the SAD later
contradicts this, a follow-up migration reconciles it; `000018` is not edited after it is applied.

## What owns what

| Column         | Type               | Notes                                                                          |
| -------------- | ------------------ | ------------------------------------------------------------------------------ |
| `id`           | `uuid`             | `gen_random_uuid()`. The stable **logical** audit identifier                   |
| `school_id`    | `uuid` NOT NULL    | FK → `app.schools(id)`. The tenant boundary                                    |
| `actor_id`     | `uuid` NULL        | FK → `app.users(id, school_id)`. NULL = system-initiated                       |
| `action`       | `app.audit_action` | `insert`, `update`, `delete`, `login`, `logout`, `export`, `permission_change` |
| `target_table` | `text` NOT NULL    | The relation the event concerns                                                |
| `target_id`    | `uuid` NOT NULL    | The row the event concerns                                                     |
| `old_values`   | `jsonb` NULL       | Prior record state                                                             |
| `new_values`   | `jsonb` NULL       | Subsequent record state                                                        |
| `client_ip`    | `inet` NULL        | Where the request came from                                                    |
| `user_agent`   | `text` NULL        | What issued it                                                                 |
| `created_at`   | `timestamptz`      | When it was recorded. **The partition key**                                    |

Primary key: `(id, created_at)`. Candidate key: `uq_audit_logs_id_school_created (id, school_id, created_at)`.

### There is no `updated_at`

Every other table in this schema carries `updated_at` plus a `ck_<table>_timestamps` check. This one
deliberately does not. An append-only row can never be updated, so an `updated_at` would be a column
permanently equal to `created_at`, functionally dependent on nothing, promising an affordance the table
does not have. Its absence is the schema stating the append-only contract.

### `timestamptz`, not `timestamptz(3)`

Attendance (`000012`) pins millisecond precision because a foreign key compares its `created_at` for
equality across a driver round-trip. Nothing references `app.audit_logs` — an audit log is a leaf, by
construction — so that constraint does not apply and full `timestamptz` precision is kept.

## Normalization review

### 1NF — atomic values, no packed blob

Every column holds a single atomic value. The **relational envelope** of the event — who, which tenant,
what kind of change, against which record, from where, when — is decomposed into distinct, typed,
constrained columns (`actor_id`, `school_id`, `action`, `target_table`, `target_id`, `client_ip`,
`user_agent`, `created_at`). None of it is packed into a JSON document.

`action` is an enum (`app.audit_action`), not free text, so its domain is enforced by the database rather
than by convention. `client_ip` is `inet`, not text, so a malformed address cannot be stored.

The two `jsonb` columns are the deliberate exception, and they are discussed in
[safe payload storage](#safe-payload-storage-a-deliberate-denormalization) below. They are _not_ a 1NF
violation of the envelope: they hold the record states the event is _about_, not the attributes of the
event itself.

### 2NF — full dependency on the whole key

The primary key is `(id, created_at)`. Every non-key column depends on the event as a whole. There is no
partial dependency on `id` alone or `created_at` alone, because neither is independently meaningful: `id`
without `created_at` does not identify a row (see [the uniqueness
limitation](#the-uniqueness-limitation)), and `created_at` is shared by any number of concurrent events.

Nothing transient or session-scoped that is functionally independent of the event is stored here. There
is no session token, no request-correlation state, no partially-materialized permission set — those
belong to the request, not to the audited fact. `client_ip` and `user_agent` are retained because they
are properties _of the recorded event_, which is exactly what an auditor needs to answer "was this us?".

### 3NF — no transitive dependencies

No actor profile field is duplicated here. There is no `actor_email`, no `actor_name`, no `school_name`,
no `actor_role`. Those are functionally dependent on `actor_id` and `school_id`, which are foreign keys;
copying them into the audit row would be a transitive dependency (`id → actor_id → actor_email`) and
would let the audit log drift out of step with the entities it points at.

The cost of this discipline is a join when rendering an audit trail for a human. That is the right trade:
an audit log that says a user's email was `x@y.test` _at the time of writing_ is not more truthful than
one that resolves the current email through a foreign key — it is merely a second, unmaintained copy
that can now disagree with `app.users`.

> **If** point-in-time actor attribution is ever genuinely required (e.g. "show the actor's name as it was
> then"), the correct answer is not to denormalize this table. It is to audit `app.users` itself — every
> change to a user already produces an `audit_logs` row with `target_table = 'users'` and the prior name
> in `old_values` — and reconstruct the name at any instant from that history.

### Safe payload storage (a deliberate denormalization)

`old_values` and `new_values` are `jsonb`. This is a considered denormalization, not an oversight.

An audit log must capture the before/after state of **any** table in the schema, each with a different
and independently evolving column set. The relational alternatives are both worse:

- **One column per auditable attribute** across the whole product — unworkable, and it would require a
  migration to this table every time any other table gained a column.
- **An EAV key/value child table** — loses type fidelity, and costs a join and N rows per audited row on
  the write path, which is the hot path.

`jsonb` captures the polymorphic delta exactly, in one column, with no schema coupling.

**The rule that keeps this honest: the JSONB holds payload state only.** No routing or ownership column
— `school_id`, `actor_id`, `target_id`, `action` — is ever read out of it. Those are real columns,
indexed and constrained, because the tenant boundary and every query path depend on them. A `school_id`
that lived only inside `new_values` could not be an RLS predicate, could not be a foreign key, and could
not lead an index. This is the difference between deliberate denormalization and a JSON dumping ground.

Two check constraints hold the payloads to their contract:

- `ck_audit_logs_{old,new}_values` — each must be a JSON **object** (`jsonb_typeof(...) = 'object'`) or
  SQL NULL. A scalar, an array, or the JSON value `null` is not a record state and is rejected.
- `ck_audit_logs_payload` — the payload must agree with the verb: an `insert` has no prior state, a
  `delete` has no subsequent state, an `update` has both. Otherwise the row is not a delta anyone can
  reconstruct. The non-DML actions (`login`, `export`, …) describe no row change and carry neither.

## Keys and functional dependencies

### The uniqueness limitation

PostgreSQL can only enforce a unique constraint on a partitioned table if the constraint **contains the
partition key**. The primary key is therefore `(id, created_at)`, and:

> **`id` alone is NOT enforced unique across partitions.** Two rows in different monthly partitions could,
> in principle, share an `id`. The database does not prevent it, and this document does not claim that it
> does.

How it is mitigated:

- `id` is generated by `gen_random_uuid()` — a cryptographically random UUIDv4 with **122 bits of
  entropy**. A collision is not a practical risk; it is operationally negligible, not merely unlikely.
- It is generated **by the database**, on a `DEFAULT`, so no application bug can supply a duplicate by
  reusing a value.
- `uq_audit_logs_id_school_created (id, school_id, created_at)` makes `(id, school_id, created_at)` a
  tenant-checked identity and backs the pruned lookup of a single audit row by id.

What consumers must do: **treat `(id, created_at)` as the physical row identity.** An API that exposes an
audit row should carry both. A lookup by bare `id` is not just unenforced — it cannot prune, and will
probe every partition (see below).

## RLS and grants

The canonical ST-034 policy, installed by `app.apply_tenant_isolation('app', 'audit_logs')`:

```sql
CREATE POLICY tenant_isolation ON app.audit_logs AS PERMISSIVE FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);
```

RLS is **enabled and forced** on the parent and, separately, on every partition — RLS does not cascade,
and `studafy_app` can name a partition directly.

Append-only is enforced at two independent layers. See
[the runbook](audit-log-partition-maintenance.md#append-only-is-not-negotiable) for the operator's view.

1. **Grants.** `studafy_app` holds `SELECT` and `INSERT`, nothing else. PostgreSQL checks privileges
   _before_ row policies, so the permissive `FOR ALL` policy above cannot widen this: there is no `UPDATE`
   or `DELETE` privilege for it to apply to.

   The explicit `REVOKE ALL … FROM studafy_app` before the `GRANT` is **mandatory**. `000002` sets
   `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO studafy_app`, so this
   table arrives with `UPDATE` and `DELETE` already granted. A bare `GRANT SELECT, INSERT` would have left
   them in place, and the table would have _looked_ append-only without being it. The same `REVOKE` runs
   inside `app.create_audit_log_partitions`, so every future month inherits it.

2. **A trigger.** Grants do not bind `studafy_admin`, which owns the table.
   `trg_audit_logs_append_only` raises `42501` on every `UPDATE` and `DELETE`, from every role, owner
   included. Row triggers on a partitioned parent are cloned to every partition, so naming a partition
   directly is rejected exactly like naming the parent.

   This does not obstruct retention: dropping a month is DDL, not a row `DELETE`.

No restrictive policy is added. Append-only is a _privilege_ question, and RLS is the wrong instrument
for it — a policy can hide rows from a mutation, but it cannot make the mutation an error.

## Index rationale

Three indexes, all `school_id`-leading:

```sql
-- 1. Target investigation (the primary audit path)
CREATE INDEX idx_audit_logs_school_target
  ON app.audit_logs (school_id, target_table, target_id, created_at DESC);
-- 2. Actor investigation
CREATE INDEX idx_audit_logs_school_actor
  ON app.audit_logs (school_id, actor_id, created_at DESC);
-- 3. Temporal school auditing
CREATE INDEX idx_audit_logs_school_created
  ON app.audit_logs (school_id, created_at DESC);
```

An audit log is **write-heavy and read-sparse**, so every index is a permanent tax on the hot path. Only
the three access paths the product actually has are indexed, and nothing is added speculatively.

`school_id` leads all three because it satisfies the RLS predicate's equality lookup and is the only
column present in every audit query by construction — a query that does not name a school cannot see a
row. `created_at DESC` is the trailing column of each, so "newest first" is satisfied by the index scan
rather than a sort.

Indexes are declared on the **parent only**. PostgreSQL creates a partition-local index on every existing
partition and on every partition attached later, so the maintenance function never creates indexes and
none is declared twice.

> Partition-local indexes do **not** inherit the parent's name. PostgreSQL generates one from the
> partition and column list — `audit_logs_y2026m07_school_id_target_table_target_id_create_idx`, truncated
> to 63 characters — which is why the plans below never mention `idx_audit_logs_school_target` literally.

### Redundancy review

| Index                                              | Leftmost prefixes                         | Redundant? |
| -------------------------------------------------- | ----------------------------------------- | ---------- |
| `(school_id, target_table, target_id, created_at)` | `school_id`; `school_id, target_table`; … | no         |
| `(school_id, actor_id, created_at)`                | `school_id`; `school_id, actor_id`        | no         |
| `(school_id, created_at)`                          | `school_id`                               | no         |

`(school_id, created_at)` is **not** a leftmost prefix of either composite: both place a discriminator
(`target_table`, `actor_id`) in the second position, so neither can serve a query that constrains only
school and time. All three are load-bearing.

**No standalone index on `school_id`** is created — it is the leftmost prefix of all three above and would
be pure write amplification. `idx_audit_logs_school_actor` additionally backs the actor foreign key's
parent-update check, so it earns its keep twice.

## Why every audit query needs a time range

**Partition pruning is driven by `created_at`, not by `school_id`.** This is the single most important
operational fact about querying this table, and it is easy to get wrong: `school_id` leads every index,
so a school-scoped query _feels_ well-targeted — and it is, _within each partition it visits_. It just
visits all of them.

### Bounded query — prunes to one partition

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT id, action, old_values, new_values, created_at
FROM app.audit_logs
WHERE school_id = current_setting('app.school_id')::uuid
  AND target_table = 'classes'
  AND target_id = '11111111-1111-4111-8111-111111111111'
  AND created_at >= '2026-07-01 00:00:00+00'
  AND created_at <  '2026-08-01 00:00:00+00'
ORDER BY created_at DESC
LIMIT 50;
```

```text
 Limit (actual rows=1 loops=1)
   ->  Index Scan using audit_logs_y2026m07_school_id_target_table_target_id_create_idx
         on audit_logs_y2026m07 audit_logs (actual rows=1 loops=1)
         Index Cond: ((school_id = (current_setting('app.school_id'::text))::uuid)
                  AND (target_table = 'classes'::text)
                  AND (target_id = '11111111-1111-4111-8111-111111111111'::uuid)
                  AND (created_at >= '2026-07-01 00:00:00+00'::timestamp with time zone)
                  AND (created_at <  '2026-08-01 00:00:00+00'::timestamp with time zone))
(3 rows)
```

**One** partition. **One** index scan. No sort, no `Append`. Every predicate is an index condition.

### The same query without a time range

```sql
-- identical, minus the two created_at bounds
```

```text
 Limit (actual rows=1 loops=1)
   ->  Sort (actual rows=1 loops=1)
         Sort Key: audit_logs.created_at DESC
         ->  Append (actual rows=1 loops=1)
               ->  Seq Scan on audit_logs_y2026m06 audit_logs_1 (actual rows=0 loops=1)
                     Filter: ((target_table = 'classes'::text) AND (target_id = '1111…'::uuid) AND …)
               ->  Index Scan using audit_logs_y2026m07_school_id_target_table_target_id_create_idx
                     on audit_logs_y2026m07 audit_logs_2 (actual rows=1 loops=1)
               ->  Seq Scan on audit_logs_y2026m08 audit_logs_3 (actual rows=0 loops=1)
               ->  Seq Scan on audit_logs_y2026m09 audit_logs_4 (actual rows=0 loops=1)
               ->  Seq Scan on audit_logs_y2026m10 audit_logs_5 (actual rows=0 loops=1)
               ->  Seq Scan on audit_logs_y2026m11 audit_logs_6 (actual rows=0 loops=1)
               ->  Seq Scan on audit_logs_y2026m12 audit_logs_7 (actual rows=0 loops=1)
               ->  Seq Scan on audit_logs_y2027m01 audit_logs_8 (actual rows=0 loops=1)
               ->  Seq Scan on audit_logs_y2027m02 audit_logs_9 (actual rows=0 loops=1)
               ->  … audit_logs_y2027m03 … y2027m04 … y2027m05 … y2027m06 … y2027m07
(33 rows)
```

**All 14 partitions**, an `Append`, an extra `Sort`, and 13 sequential scans — on a database with 3,001
rows. The empty partitions are seq-scanned because on a tiny relation that is cheaper than an index
probe; at production scale they become 13 index probes instead, which is better but still linear in the
number of months the table has ever existed. **The cost of this query grows forever.** Ten years in, it
touches 120 partitions.

### The rule

> Every audit search **must** carry a `created_at` range. The audit search API should require one — a
> default of `created_at >= now() - interval '30 days'` is far better than an unbounded scan, and an
> explicit range is better still.

```sql
-- Good: bounded, prunes.
WHERE school_id = … AND created_at >= now() - interval '30 days' AND …

-- Bad: correct, but scans every partition that has ever existed.
WHERE school_id = … AND target_id = …
```

This applies to lookup by `id` too: `WHERE id = '…'` cannot prune. Carry `created_at` alongside the id —
which is what [the uniqueness limitation](#the-uniqueness-limitation) requires anyway.

## Batch append benchmark

The ST-046 acceptance target: appending **100 audit logs in a single batch transaction in under 20 ms**.

Measured by `packages/db/tests/audit-logs-benchmark.test.ts` (`AUDIT_LOGS_BENCHMARK=1`), against a
partition already holding a 5,000-row backlog, with every control left on: one transaction,
transaction-local tenant GUC, forced RLS with the tenant policy evaluated on every appended row, both
foreign keys, every check constraint, the append-only trigger armed, and all three indexes maintained on
write. Nothing is disabled to flatter the number.

Recorded on the development container (`pgvector/pgvector:pg16`, Docker Desktop, 30 measured iterations
after 5 warmup iterations):

```text
audit append (100 logs x 30 iterations, 1 round-trip per batch, 5000-row backlog)
  database:   mean 5.35ms, min 3.4ms, max 12.37ms over 30 batches
  end-to-end: min 5.88ms, median 7.64ms, p95 15.76ms, max 16.64ms
  transport:  2ms per exchange on this host (budget 22ms = 20ms target + transport)
```

**Result: 5.4 ms mean server time against a 20 ms budget.** The gate is asserted twice — the database's own
mean execution time (from `pg_stat_statements`) must fit inside 20 ms outright, and the end-to-end median
must fit inside 20 ms once the host's unavoidable single network exchange is charged to the host.

The batch is issued as a **single multi-row `INSERT`**, which is what an audit writer should do. 100
separate statements would measure the network, not the schema. The two foreign keys point at _ordinary_
tables (`app.schools`, `app.users`), so this path avoids the ~12× per-check penalty `000012` documents for
referencing a _partitioned_ table.

## Known gaps

- **No application writer yet.** This ticket delivers the data model, not the code that appends to it. The
  `auditLog:read` / `auditLog:export` permissions in `packages/constants/src/permissions.ts` still have no
  read API behind them.
- **Production partition scheduling is not deployed** — shared with attendance. See the runbook.
- **Retention is out of scope.** Nothing is ever dropped automatically, and the append-only trigger makes
  row-level deletion impossible by design. See the runbook's retention section, which lists the questions
  that must be answered before a policy exists.
- **`id` is not unique across partitions.** See [the uniqueness limitation](#the-uniqueness-limitation).
- **`target_table` is not a foreign key to the catalog**, deliberately: an audit row must survive the
  table it describes being renamed or dropped. A typo in `target_table` is therefore possible and is not
  caught by the database.
