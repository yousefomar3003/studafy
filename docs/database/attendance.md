# Attendance model

Created by `000012_create_attendance_tables_with_partitioning.sql` (ST-040). The ERD is in
[attendance-data-model](../api/attendance-data-model.md); operating the partitions is covered by
[attendance-partition-maintenance](attendance-partition-maintenance.md).

Four tables:

| Table                         | Partitioned              | Purpose                                   |
| ----------------------------- | ------------------------ | ----------------------------------------- |
| `app.attendance_sessions`     | monthly, on `created_at` | one attendance-taking event for one class |
| `app.attendance_records`      | monthly, on `created_at` | one student's outcome in one session      |
| `app.attendance_session_keys` | no                       | enforces the session business key         |
| `app.attendance_record_keys`  | no                       | enforces the record business key          |

## Domain decisions

Nothing in the repository defined attendance semantics before this ticket — there is no SAD, and no ADR
or API document names a status vocabulary. The following were chosen for ST-040 and are open to
revision by a product decision.

- **Granularity.** A session is one class on one `session_date`, optionally for one `period`. `period`
  is the same opaque, school-defined ordinal as `app.timetable_slots.period`; there is no periods
  table and no wall-clock times in the schema. `period IS NULL` means the school takes attendance once
  per class per day. A school may use either regime; the business key permits exactly one session
  either way.
- **Session lifecycle.** `draft → open → submitted → locked`, with `cancelled` available from any
  state. This is _not_ enforced by a state-machine trigger: the enum constrains the values, nothing
  constrains the transitions. Add a trigger only when a requirement demands it.
- **Attendance status.** `present`, `absent`, `late`, `excused`, `remote`.
- **`minutes_late`** is optional, must be non-negative, and may only be set when `status = 'late'`.
- **Enrollment is not checked.** A record can be written for a student who is not enrolled in the
  session's class. The database does not prevent it and this document does not claim it does.
  Enrollment eligibility is service-layer logic.

## Business date versus `created_at`

`session_date` (type `date`) is the educational date the attendance is _for_. `created_at` is when the
row was written and is the partition key. They are deliberately separate:

- schools operate in different time zones, so "the school day" is not derivable from a UTC instant;
- attendance is corrected, and imported, after the fact.

A session for 2026-09-14 that is backfilled in October lives in October's partition and still reports
2026-09-14. Nothing in the schema derives one from the other.

## Timestamp precision

`created_at`, `updated_at` and `session_created_at` on the attendance tables are `timestamptz(3)`, not
the bare `timestamptz` used everywhere else in the schema. This is the only place in Studafy where a
timestamp is compared for equality by a foreign key.

PostgreSQL stores `timestamptz` at microsecond precision, but the repository's driver
(`postgres@3.4.9`) transports a bound timestamp parameter at **millisecond** precision — verified: a
value stored as `…:47.423613+00` comes back through a parameter as `…:47.423+00`. An application that
reads a session's `created_at` and sends it back to reference that session would therefore never match
its own row, and `fk_attendance_records_session` would reject every roster. Pinning the stored
precision to milliseconds makes the round-trip exact by construction rather than making every caller
responsible for avoiding the trap. Milliseconds are ample for an audit and routing timestamp, and `id`
remains a UUID, so no key loses discriminating power. Partition boundaries are unaffected.

## Uniqueness: what the database actually enforces

PostgreSQL can only enforce a unique constraint on a partitioned table if the constraint includes the
partition key. The attendance business keys do not include `created_at`, so **they cannot be enforced
on the partitioned tables at all**. A constraint like
`UNIQUE (school_id, class_id, session_date, created_at)` would be enforced, but it is not the business
key: two sessions for the same class and date, created a second apart, would both be accepted.

So the business keys live on two small unpartitioned registry tables, kept 1:1 with their parents by
`AFTER INSERT OR UPDATE OR DELETE ... FOR EACH ROW` triggers:

- `app.attendance_session_keys` — `UNIQUE NULLS NOT DISTINCT (school_id, class_id, session_date, period)`
- `app.attendance_record_keys` — `PRIMARY KEY (school_id, attendance_session_id, student_id)`

A duplicate raises `23505` from the database, **including when the two rows would land in different
monthly partitions** — which is the case a partition-local constraint could never catch. This is
tested explicitly.

The registries are locked down: the trigger functions are `SECURITY DEFINER` and owned by
`studafy_admin`, and `studafy_app` holds `SELECT` on the registries and nothing else. Without that, the
runtime role could park a key row to permanently block a legitimate session, or delete one to admit the
duplicate the registry exists to prevent. (The explicit `REVOKE` matters: the default privileges in
`000002` grant `studafy_app` full CRUD on every table `studafy_admin` creates in `app`, so granting
`SELECT` alone would have left the write rights in place.)

What is **not** enforced: `id` alone is not unique on either partitioned table. Only `(id, created_at)`
is. `id` is a `gen_random_uuid()` surrogate so a collision is not a practical concern, but the database
does not guarantee it.

## Why `attendance_records` references the registry

`fk_attendance_records_session` targets `app.attendance_session_keys`, not `app.attendance_sessions`.

Referencing the partitioned table directly is _possible_ — `uq_attendance_sessions_id_school_created`
exists precisely so that it can be — but a referential check against a partitioned table is roughly
twelve times as expensive as one against an ordinary table, and it is paid per row on every roster
written. Measured on the development container, that one foreign key was 15 ms of a 19 ms 40-record
batch. (The cost is _flat_ in the number of partitions — 8 partitions and 44 partitions measured the
same — so it is per-check overhead, not a partition-pruning failure.)

The registry is a faithful, tamper-proof image of the session: the trigger keeps it 1:1 and no role
other than the trigger can write it. "A row exists in `attendance_session_keys` with this
`(school_id, attendance_session_id, session_created_at)`" is true exactly when the corresponding
session row exists, so the guarantee is identical and only the physical target differs. Deleting a
session deletes its registry row, which this foreign key then blocks with `RESTRICT` while any record
still references it — the same protection a direct reference gives.

## Normalization review

Both tables are in third normal form.

### `app.attendance_sessions`

- **Primary key** `(id, created_at)` — `created_at` is present only because PostgreSQL requires the
  partition key in every unique constraint on a partitioned table.
- **Candidate keys** `(id, school_id, created_at)`; the business key
  `(school_id, class_id, session_date, period)` is a candidate key of the entity but is enforced on
  `attendance_session_keys`, not here.
- **Partition key** `created_at`. **Tenant boundary** `school_id`.
- **Foreign keys** `school_id → schools(id)`; `(class_id, school_id) → classes(id, school_id)`;
  `(taken_by_user_id, school_id) → users(id, school_id)`.
- **Functional dependencies** `(id, created_at) → school_id, class_id, session_date, period, status,
taken_by_user_id, updated_at`. Every non-key attribute describes the attendance-taking event itself.
- **1NF** every column is atomic; no roster array, no JSONB status map, no `student_1_status` columns,
  no comma-separated absentee list. **2NF/3NF** no transitive dependency: no class code, course name,
  teacher name, room, or school slug is copied here, and no present/absent count or attendance
  percentage is persisted.

### `app.attendance_records`

- **Primary key** `(id, created_at)`, for the same reason.
- **Candidate keys** the business key `(school_id, attendance_session_id, student_id)`, enforced on
  `attendance_record_keys`.
- **Partition key** `created_at`. **Tenant boundary** `school_id`.
- **Foreign keys** `school_id → schools(id)`;
  `(school_id, attendance_session_id, session_created_at) → attendance_session_keys`;
  `(student_id, school_id) → students(id, school_id)`;
  `(recorded_by_user_id, school_id) → users(id, school_id)`.
- **Functional dependencies** `(id, created_at) → school_id, attendance_session_id,
session_created_at, student_id, status, minutes_late, reason, recorded_by_user_id, updated_at`.
- **1NF/2NF/3NF** one row per student per session. No student name or admission number, no class code,
  and deliberately **no `class_id` and no `attendance_date`** — both are functionally dependent on the
  session and would be copies. The class/date access path starts at `attendance_sessions`, which
  carries the required index; record queries join down from a session.

### The one deliberate duplication

`attendance_records.session_created_at` copies `attendance_sessions.created_at`.

- **Source of truth** `app.attendance_sessions.created_at`.
- **Reason** a reference to a session must identify one specific session row; carrying its `created_at`
  also lets a join back to the session constrain the partition key and prune to a single month instead
  of probing every partition.
- **Consistency** enforced by `fk_attendance_records_session` against the registry, which itself is
  trigger-maintained from the session. It cannot drift, and it cannot be mutated independently to point
  at a session that does not exist.
- **Tenant implication** none; `school_id` is part of the same key, so the reference is tenant-checked.

## Indexes

Declared on the partitioned parents only. PostgreSQL creates the matching partition-local index on
every existing partition and on every partition attached later, so `app.create_attendance_partitions`
creates no indexes itself and nothing is declared twice. A catalog test asserts no relation carries two
indexes over the same columns.

| Index                                                                                            | Query it serves                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `idx_attendance_sessions_school_class_date` `(school_id, class_id, session_date, id)`            | **The required leading index.** The attendance session for a class on a date; a class's sessions over a date range. Trailing `id` makes ordering deterministic for pagination. |
| `idx_attendance_sessions_school_taken_by` `(school_id, taken_by_user_id)`                        | Backs the `taken_by_user_id` FK's parent-delete check, and "sessions taken by this teacher".                                                                                   |
| `idx_attendance_records_school_session_student` `(school_id, attendance_session_id, student_id)` | The roster read for one session, and the batch-write conflict lookup. Its `(school_id, attendance_session_id)` prefix also backs the session FK.                               |
| `idx_attendance_records_school_student_created` `(school_id, student_id, created_at DESC, id)`   | One student's attendance history, newest first. Constrains `created_at`, so it prunes partitions. Its prefix also backs the student FK's parent-delete check.                  |
| `idx_attendance_records_school_recorded_by` `(school_id, recorded_by_user_id)`                   | Backs the `recorded_by_user_id` FK's parent-delete check.                                                                                                                      |

Not added: any status-only or boolean-only index (no query needs one); a second date index on records
(records have no date column — the session owns it); redundant single-column FK indexes where a
composite index already has the useful leftmost prefix (`school_id`, `class_id`, `student_id`,
`attendance_session_id` are all covered).

The RLS predicate stays index-friendly: the policy casts the GUC (`current_setting('app.school_id')::uuid`),
never the indexed `school_id` column, and every tenant index leads with `school_id`.

### Partition pruning

Pruning depends on constraining **`created_at`**, not `session_date`. Verified with `EXPLAIN`:

- `WHERE school_id = … AND class_id = … AND created_at >= … AND created_at < …` → one partition scanned.
- `WHERE school_id = … AND student_id = … AND created_at >= … AND created_at < …` → one partition scanned.
- `WHERE school_id = … AND class_id = … AND session_date = …` → **all** partitions scanned, on the
  correct index in each. This is inherent to partitioning on `created_at` while querying by business
  date. History queries that can bound `created_at` should do so; the test asserts this behaviour
  rather than pretending it away.

## Batch insert benchmark

The acceptance target is 40 attendance records inserted in under 50 ms in development.

**Path measured** (`packages/db/tests/attendance-benchmark.test.ts`): one transaction, one multi-row
`INSERT … SELECT … FROM unnest($students)` through the partitioned parent, tenant GUC set
transaction-locally, with forced RLS, all foreign keys, all check constraints and the registry trigger
active. Nothing is disabled. The session is created outside the timed region because opening a session
and submitting the roster are separate requests. 5 warm-up iterations, then 30 measured.

**Two numbers are recorded, and they mean different things.**

- **Database time** — the server's own execution time for those `INSERT` statements, read from
  `pg_stat_statements` (reset after the warm-up, so it covers exactly the measured iterations). This is
  the cost the schema controls: constraints, the registry trigger, RLS, index maintenance, partition
  routing.
- **End-to-end time** — `performance.now()` around the whole transaction. It additionally contains five
  network round-trips per iteration (`BEGIN`, `SET LOCAL ROLE`, `set_config`, `INSERT`, `COMMIT`).

**The test asserts the 50 ms target against the end-to-end median** and also requires the database mean
to remain below 50 ms. CI runs this benchmark as a dedicated step with `ATTENDANCE_BENCHMARK=1`, rather
than mixing a host-sensitive latency measurement into the concurrent integration suite. The server
figure diagnoses schema cost; the end-to-end median is the ticket's development acceptance result.
The p95 and maximum remain reported rather than hidden, but are not production SLAs.

**Environment.** PostgreSQL 16 (`pgvector/pgvector:pg16`) in Docker Desktop on Windows 11 (WSL2
backend), data directory on `tmpfs`, connected over `127.0.0.1:54329`. One school, one class, 40
enrolled students, 8 monthly partitions per parent, empty attendance tables at the start of the run.

**Result** — 40 records × 30 iterations, benchmark run on its own:

|            | min      | mean / median         | p95      | max       |
| ---------- | -------- | --------------------- | -------- | --------- |
| Database   | 2.49 ms  | **5.26 ms** (mean)    | —        | 12.61 ms  |
| End-to-end | 11.76 ms | **22.15 ms** (median) | 93.08 ms | 159.35 ms |

**The target is met**: the 22.15 ms end-to-end median is below 50 ms, and the database mean is
5.26 ms. Reported honestly:

- The **end-to-end tail** is sensitive to Docker Desktop and host contention, so p95 and maximum can
  exceed 50 ms even when the isolated median and database execution time remain comfortably below it.
- A native-Linux CI runner should be faster on both figures, but **that has not been measured.**
- These are development-container numbers. **They are not a production SLA.**

**Where the time goes** (server-side medians, measured by disabling one thing at a time on a throwaway
database — nothing here is disabled in the shipped benchmark):

| Configuration                                                    | median     |
| ---------------------------------------------------------------- | ---------- |
| Full, referencing the partitioned `attendance_sessions` directly | 26.2 ms    |
| …with the registry trigger disabled                              | 18.8 ms    |
| …with the session FK also dropped                                | 3.5 ms     |
| **Shipped: referencing the unpartitioned session registry**      | **7.3 ms** |

That is what motivated pointing `fk_attendance_records_session` at the registry: it removed ~15 ms per
batch — about 75% of the server-side cost — with no loss of enforcement. The registry trigger's
remaining ~4 ms is the price of a business key the database actually enforces, and is kept.

## Known limitations

- Session status transitions are unconstrained (see above).
- Enrollment is not validated (see above).
- Queries by `session_date` alone scan every partition.
- `id` alone is not unique on the partitioned tables.
- Old partitions are never dropped automatically; retention is out of scope for ST-040 and is discussed
  in the runbook.
