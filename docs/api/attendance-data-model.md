# Attendance data model

Attendance is school-owned and tenant-isolated. `ATTENDANCE_SESSIONS` and `ATTENDANCE_RECORDS` are
declaratively range-partitioned by month on `created_at`; the two `*_KEYS` tables are ordinary
unpartitioned tables that carry the business keys PostgreSQL cannot enforce on a partitioned table.

```mermaid
erDiagram
  SCHOOLS ||--o{ CLASSES : "owns"
  SCHOOLS ||--o{ STUDENTS : "owns"
  CLASSES ||--o{ ENROLLMENTS : "has"
  STUDENTS ||--o{ ENROLLMENTS : "has"

  CLASSES ||--o{ ATTENDANCE_SESSIONS : "is registered in"
  ATTENDANCE_SESSIONS ||--|| ATTENDANCE_SESSION_KEYS : "registers business key"
  ATTENDANCE_SESSION_KEYS ||--o{ ATTENDANCE_RECORDS : "is referenced by"
  STUDENTS ||--o{ ATTENDANCE_RECORDS : "is marked in"
  ATTENDANCE_RECORDS ||--|| ATTENDANCE_RECORD_KEYS : "registers business key"

  SCHOOLS {
    uuid id PK
    text slug UK
  }
  CLASSES {
    uuid id PK_UK
    uuid school_id FK_UK
    text code
  }
  STUDENTS {
    uuid id PK_UK
    uuid school_id FK_UK
    text admission_number
  }
  ENROLLMENTS {
    uuid school_id PK_FK
    uuid class_id PK_FK
    uuid student_id PK_FK
    enrollment_status status
  }
  ATTENDANCE_SESSIONS {
    uuid id PK
    timestamptz3 created_at PK
    uuid school_id FK_UK
    uuid class_id FK
    date session_date
    smallint period
    attendance_session_status status
    uuid taken_by_user_id FK
    timestamptz3 updated_at
  }
  ATTENDANCE_SESSION_KEYS {
    uuid school_id UK
    uuid class_id UK
    date session_date UK
    smallint period UK
    uuid attendance_session_id UK
    timestamptz3 session_created_at UK
  }
  ATTENDANCE_RECORDS {
    uuid id PK
    timestamptz3 created_at PK
    uuid school_id FK
    uuid attendance_session_id FK
    timestamptz3 session_created_at FK
    uuid student_id FK
    attendance_status status
    smallint minutes_late
    text reason
    uuid recorded_by_user_id FK
    timestamptz3 updated_at
  }
  ATTENDANCE_RECORD_KEYS {
    uuid school_id PK
    uuid attendance_session_id PK
    uuid student_id PK
    uuid attendance_record_id
    timestamptz3 record_created_at
  }
```

## What the diagram does not say on its own

**Partitioning.** `ATTENDANCE_SESSIONS` and `ATTENDANCE_RECORDS` are `PARTITION BY RANGE (created_at)`,
one partition per calendar month, named `attendance_sessions_y2026m07` /
`attendance_records_y2026m07`. Boundaries are half-open and UTC:
`['2026-07-01 00:00:00+00', '2026-08-01 00:00:00+00')`. There is no `DEFAULT` partition — an insert for
a month with no partition fails loudly. New partitions are created by the administrative maintenance
command, not by the application; production scheduling of that command is an infrastructure follow-up.
See [attendance-partition-maintenance](../database/attendance-partition-maintenance.md).

**Business date vs `created_at`.** `session_date` is the educational date attendance is _for_.
`created_at` is when the row was written, and is the partition key. They are unrelated: a session for
2026-09-14 imported in October is stored in October's partition. Queries filtered only by
`session_date` cannot prune partitions.

**RLS.** `ENABLE` + `FORCE ROW LEVEL SECURITY` with the canonical `tenant_isolation` policy is applied
to both partitioned parents, to **every partition**, and to both registries. RLS on a parent does not
cascade to its partitions and does not apply when a partition is queried directly, so each partition
carries the policy in its own right; `app.create_attendance_partitions` applies it at creation time.
RLS is not an authorization layer: it does not check that a student is enrolled, or that the caller is
allowed to take attendance for this class.

**Tenant integrity is foreign keys, not RLS.** Composite keys make a cross-school link impossible even
for an administrative writer: `(class_id, school_id) → classes`, `(student_id, school_id) → students`,
`(taken_by_user_id, school_id)` and `(recorded_by_user_id, school_id) → users`.

**Why records reference `ATTENDANCE_SESSION_KEYS` and not `ATTENDANCE_SESSIONS`.** Both are possible;
the registry is 1:1 with the session, is written only by a `SECURITY DEFINER` trigger, and is an
ordinary table, so the guarantee is the same while the referential check is ~12× cheaper than one
against a partitioned table. `session_created_at` is carried so the reference identifies one specific
session row and so a join back to the session can prune to a single partition.

**Uniqueness.** PostgreSQL can only enforce a unique constraint on a partitioned table if it contains
the partition key, so the real business keys live on the registries:
one session per `(school_id, class_id, session_date, period)` (NULLs not distinct), and one record per
`(school_id, attendance_session_id, student_id)`. These hold across partitions. On the partitioned
tables themselves, `id` alone is **not** enforced unique — only `(id, created_at)` is.

**Normalization.** One row per student per session. No roster arrays, no JSONB status maps, no
duplicated student/class/school metadata, and no persisted attendance totals or percentages.

**Cardinality note.** `ENROLLMENTS` is not referenced by attendance. Whether a marked student is
actually enrolled in the class is **not** enforced by the database and remains service-layer logic.
