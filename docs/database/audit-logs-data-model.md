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
| `request_id`   | `uuid` NULL        | Which API request produced it (`000026`). NULL for non-HTTP writes             |
| `created_at`   | `timestamptz`      | When it was recorded. **The partition key**                                    |

Primary key: `(id, created_at)`. Candidate key: `uq_audit_logs_id_school_created (id, school_id, created_at)`.

### `request_id` (`000026`, ST-054)

The correlation key joining one audit row to the API log lines for the request that produced it.
`apps/api` mints a UUIDv4 per request, logs it as `request_id`, returns it as `X-Request-Id`, and sets it
as the transaction-local `app.request_id` GUC — so a client quoting a header in a bug report leads to the
log lines and to the audit rows in one step. See
[SAD 28](../architecture/SAD_28_logging_conventions.md) for the request lifecycle.

Three properties of this column that are load-bearing and easy to get wrong:

- **NULL is permanent, not a placeholder for a later `NOT NULL`.** The migrations CLI, the workers, and
  the scheduled partition-maintenance job all legitimately write with no HTTP request behind them. A NULL
  `request_id` is a correct and expected state for those rows, forever. Do not add `NOT NULL`.
- **It is not a foreign key,** and cannot be: there is no `requests` table. It points at a log line in
  CloudWatch, which the database cannot constrain, so a `request_id` naming a request that never existed
  is not caught here. This costs nothing in tenant safety — `request_id` is never a routing or ownership
  column, `school_id` remains `NOT NULL` and holds the boundary alone, and RLS scopes any lookup by
  `request_id` to one school regardless of what the value is.
- **Any reader must pass `missing_ok`:** `current_setting('app.request_id', true)`. The GUC is unset by
  construction for every non-HTTP write, and without the second argument `current_setting` raises `42704`
  on each of them. This is the exact trap `app.current_user_id()` (`000014`) already sits in.

There is **no writer yet.** Nothing in this repository inserts an `app.audit_logs` row, so this column is
NULL on every row that exists today. That is the expand half of the expand/migrate/contract policy in
[migration policy](migration-policy.md): `000026` ships the destination alongside ST-054's transport (the
GUC), so the ticket that adds the audit writer only has to add the `INSERT`.

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

`request_id` is likewise a single `uuid` atom — not a delimited string, not an array, and not a nested
document. One request typically produces several audit rows, and that one-to-many is modeled the
relational way: the value repeats across the child rows that share it. The alternative — an array of row
ids hung off a request — is exactly the nested list 1NF forbids, and there is no request entity to hang it
off in any case. `uuid` rather than `text` also means a malformed id cannot be stored, the same reasoning
`client_ip` gets.

The two `jsonb` columns are the deliberate exception, and they are discussed in
[safe payload storage](#safe-payload-storage-a-deliberate-denormalization) below. They are _not_ a 1NF
violation of the envelope: they hold the record states the event is _about_, not the attributes of the
event itself.

### 2NF — full dependency on the whole key

The primary key is `(id, created_at)`. Every non-key column depends on the event as a whole. There is no
partial dependency on `id` alone or `created_at` alone, because neither is independently meaningful: `id`
without `created_at` does not identify a row (see [the uniqueness
limitation](#the-uniqueness-limitation)), and `created_at` is shared by any number of concurrent events.

`request_id` is no exception: it depends on the whole key, because it records which HTTP request produced
_this_ row. It is not partially dependent on `id` or on `created_at`, and it is not shared with any other
key — one request commonly produces several audit rows, which is a repeated value, not a partial
dependency.

Nothing transient or session-scoped that is functionally independent of the event is stored here. There
is no session token and no partially-materialized permission set — those are request _state_, they are
not about the audited fact, and they would be functionally independent of the key. The test is not
"did this come from a request?" but "is this a property _of the recorded event_?" — which is exactly why
`client_ip`, `user_agent`, and `request_id` are all retained: each answers something an auditor asks of
the event itself. `client_ip` and `user_agent` answer "was this us?"; `request_id` answers "what else did
that same request do?", and it is the only column that can, since it is the sole handle back to the log
lines and to the sibling rows of one transaction.

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

`request_id` introduces no transitive dependency. It determines no other column here, and no column here
determines it. The discipline that keeps it that way is the same one applied to `actor_id` above: **none
of the request's other attributes are copied alongside it.** There is no `request_path`, no
`request_method`, no `response_status`. Those are functionally dependent on `request_id`, so storing them
would be the transitive dependency `id → request_id → request_path` — and they already exist, once, on
the log line keyed by that same id. Copying them here would create a second, unmaintained copy that can
disagree with the log, which is the `actor_email` mistake wearing different clothes.

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

`app.apply_tenant_isolation('app', 'audit_logs')` installs the canonical ST-034 policy:

```sql
CREATE POLICY tenant_isolation ON app.audit_logs AS PERMISSIVE FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);
```

RLS is **enabled and forced** on the parent and, separately, on every partition — RLS does not cascade,
and `studafy_app` can name a partition directly.

> **As of `000025`, that helper does two things, not one.** `app.apply_tenant_isolation` is now a wrapper
> over `app.apply_tenant_isolation_policy` (the policy above) **and**
> `app.apply_tenant_ownership_immutability`, which installs a `trg_tenant_school_id_immutable` trigger
> rejecting any `UPDATE` that changes `school_id`. `000025` also retrofitted that trigger across every
> `app` relation carrying a `school_id`, and `app.audit_logs` is one of them. Tenant ownership is a
> physical invariant there, not merely an RLS convention: a `BYPASSRLS` role or a disabled policy must
> still be unable to move a row between schools.
>
> On **this** table the ownership trigger is redundant by construction and can never fire: it is
> `BEFORE UPDATE OF school_id`, and `trg_audit_logs_append_only` (below) already rejects every `UPDATE`
> from every role, owner included. It is present because the retrofit applies uniformly to every tenant
> table, not because an append-only table needs it. It is recorded here because the physical catalog has
> it and this document is meant to match the catalog — not because it changes what this table does.

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

### `request_id` is deliberately unindexed

**No index covers `request_id`, and none was added by `000026`.** It appears in none of the three indexes
above, so a `request_id` predicate can only be a filter applied after a scan, never an index condition.

This is a documented omission rather than an oversight. The indexing standard in
[migration policy](migration-policy.md) requires every index to have a named query, integrity, join,
filter, sort, or pagination purpose, and requires an intentional omission to be recorded. **There is no
such query: no writer, no reader, no endpoint** — the column is NULL on every row that exists. An index
here would be precisely the speculative index the standard forbids, and this is the most write-heavy
table in the schema, where every index is a permanent tax on the hot path that `000018` already justifies
three times over.

| Index                                      | Status          | Why                                                |
| ------------------------------------------ | --------------- | -------------------------------------------------- |
| `(request_id)`                             | **not created** | Tenant-blind; wrong shape even once a query exists |
| `(school_id, request_id, created_at DESC)` | **not created** | Right shape, but no query names it yet             |

When a real lookup arrives it will not want a bare `request_id` index anyway. A tenant-blind index is
school-last, prunes no monthly partition, and contradicts the school-leading shape the ST-050 RLS
coverage check expects of every tenant-scoped table. The index that query will want is
`idx_audit_logs_school_request_created (school_id, request_id, created_at DESC)`, and it belongs to the
ticket that can name the query and measure it — not to this one.

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

It applies to `request_id` with particular force, because that is the one lookup whose caller usually
_has_ the timestamp and may not think to use it. "Show me everything request `3f2b…` did" arrives from a
log line or a bug report, and both carry the time the request happened. Without a `created_at` bound that
query scans every partition **and** — since nothing indexes `request_id` — filters rather than seeks
inside each one. Bound it to the day the log line is from.

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
- **`request_id` is NULL on every row** until that writer exists, and it is
  [unindexed by design](#request_id-is-deliberately-unindexed). It is also not a foreign key and never can
  be — nothing constrains it to a request that actually happened.
- **Production partition scheduling is not deployed** — shared with attendance. See the runbook.
- **Retention is out of scope.** Nothing is ever dropped automatically, and the append-only trigger makes
  row-level deletion impossible by design. See the runbook's retention section, which lists the questions
  that must be answered before a policy exists.
- **`id` is not unique across partitions.** See [the uniqueness limitation](#the-uniqueness-limitation).
- **`target_table` is not a foreign key to the catalog**, deliberately: an audit row must survive the
  table it describes being renamed or dropped. A typo in `target_table` is therefore possible and is not
  caught by the database.
