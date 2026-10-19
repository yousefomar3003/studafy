# Demo tenant seeding guide (ST-052)

`bun run db:seed` builds one fully-populated demo School and its educational ecosystem for local
development, staging, and end-to-end testing. The seed is written entirely in TypeScript under
[`db/seeds`](../../db/seeds) using the existing `postgres` driver and the same
`loadMigrationConfig`/`createClient` connection layer as the migration CLI — it is not a new
framework. The whole dataset is written in a single transaction, so it is all-or-nothing.

Seeding is source-of-truth-neutral: it never changes the schema. The schema is owned by the ordered
migrations in [`db/migrations`](../../db/migrations); see
[migration-policy.md](./migration-policy.md).

## What gets seeded

One School (`studafy-demo-academy`) with a billing subscription, and, scoped to it: users across every
role with mock OAuth logins, student/teacher/parent profiles, an academic year with two terms,
subjects, courses, rooms, classes and enrollments, an approved timetable, attendance sessions and
records, assignments/submissions and exams/results, gradebooks with published grades, materials with
pre-embedded vector chunks, ERPNext finance caches (invoices, payments, fee schedule), AI
subscriptions/conversations/messages/citations/usage, notifications, devices, school calendar events
(`app.school_events`, migration 000121: one meeting, event, exam period, and holiday around the seed's
"today"), one parent-teacher messaging thread (migration 000127: Bassel Fares and Layla Nasser about
Adam, plus the parent's `DIRECT_MESSAGE` notification), domain-event outbox rows, and audit-log
entries — 40+ interconnected `app.*` tables in all.

This TypeScript seed is the only seeder: there are no SQL seed files and no `cli.ts seed` command.

## Running it

The seed refuses to run against anything but a local/loopback database (see **Production safeguard**
below), and it targets an already-migrated database. From the repository root (`studafy/`):

```bash
# 1. Start disposable PostgreSQL 16 (pgvector) — data is on tmpfs and destroyed with the container.
POSTGRES_PASSWORD='<local-only-password>' docker compose up -d --wait test-postgres test-redis

# 2. Point the tooling at it.
export DATABASE_URL='postgresql://studafy_test:<local-only-password>@127.0.0.1:54329/postgres?sslmode=disable'

# 3. Apply the full schema, then seed.
bun run db:migrate
bun run db:seed            # prints a per-table row-count summary + index-health PASS; expected < 2s

# 4. (Optional) re-run the index health report on its own.
bun run db:seed:index-check

# Tear down.
docker compose rm -sfv test-postgres test-redis
```

PowerShell uses the same values through `$env:POSTGRES_PASSWORD` and `$env:DATABASE_URL`:

```powershell
$env:POSTGRES_PASSWORD = '<local-only-password>'
docker compose up -d --wait test-postgres test-redis
$env:DATABASE_URL = 'postgresql://studafy_test:<local-only-password>@127.0.0.1:54329/postgres?sslmode=disable'
bun run db:migrate
bun run db:seed
```

Re-running `bun run db:seed` against an already-seeded database is a **clean no-op**: it detects the
demo school's slug, writes nothing, and exits non-zero with a message rather than duplicating data. To reseed, recreate or
re-migrate a fresh database (the disposable container makes this a `down`/`up` cycle).

> Attendance and audit-log rows are dated inside the monthly partitions the migrations ship
> (2026-06 … 2027-01). A database first migrated after 2027-01 must have its rolling partitions created
> first (`bun run db:attendance:partitions`, `bun run db:audit:partitions`) before seeding.

## Mock credentials (by role)

There is no password store in the schema — authentication is external OAuth, modeled by
`app.oauth_identities (provider, subject)`. Every persona logs in through the mock provider
`mock` with **subject = email**, which a local auth stub maps directly. Parents carry the `PARENT`
role (migration 000043) and are related to their children via `app.parent_child_links`.

These logins are defined once in [`db/seeds/mock-credentials.ts`](../../db/seeds/mock-credentials.ts)
and drive both the seed and this table, so they cannot drift.

### Administrators & staff

| Role                 | Name           | Email (OAuth subject)              |
| -------------------- | -------------- | ---------------------------------- |
| `SUPER_ADMIN`        | Sana Al-Rashid | `superadmin@demo.studafy.test`     |
| `ORG_ADMIN`          | Omar Haddad    | `admin@demo.studafy.test`          |
| `PRINCIPAL`          | Samir Qasem    | `principal@demo.studafy.test`      |
| `ATTENDANCE_OFFICER` | Hala Mansour   | `attendance@demo.studafy.test`     |
| `FINANCE`            | Reem Saadeh    | `finance@demo.studafy.test`        |
| `INSTRUCTOR`         | Layla Nasser   | `layla.nasser@demo.studafy.test`   |
| `INSTRUCTOR`         | Hassan Ibrahim | `hassan.ibrahim@demo.studafy.test` |
| `INSTRUCTOR`         | Mona Farouk    | `mona.farouk@demo.studafy.test`    |

### Students (`STUDENT`)

| Name         | Email (OAuth subject)            |
| ------------ | -------------------------------- |
| Yara Khalil  | `yara.khalil@demo.studafy.test`  |
| Adam Fares   | `adam.fares@demo.studafy.test`   |
| Nour Saleh   | `nour.saleh@demo.studafy.test`   |
| Zaid Mansour | `zaid.mansour@demo.studafy.test` |
| Lina Haddad  | `lina.haddad@demo.studafy.test`  |
| Omar Darwish | `omar.darwish@demo.studafy.test` |
| Huda Rahman  | `huda.rahman@demo.studafy.test`  |
| Sami Aziz    | `sami.aziz@demo.studafy.test`    |
| Mira Fares   | `mira.fares@demo.studafy.test`   |

### Parents (`PARENT` + `parent_child_links`)

| Name          | Email (OAuth subject)              | Children (relationship)                  |
| ------------- | ---------------------------------- | ---------------------------------------- |
| Rania Khalil  | `khalil.parent@demo.studafy.test`  | Yara Khalil (mother)                     |
| Bassel Fares  | `fares.parent@demo.studafy.test`   | Adam Fares (father), Mira Fares (father) |
| Maha Saleh    | `saleh.parent@demo.studafy.test`   | Nour Saleh (mother)                      |
| Tariq Mansour | `mansour.parent@demo.studafy.test` | Zaid Mansour (father)                    |
| Dalia Haddad  | `haddad.parent@demo.studafy.test`  | Lina Haddad (guardian)                   |
| Karim Darwish | `darwish.parent@demo.studafy.test` | Omar Darwish (father)                    |

Each parent has one family (`app.families`) holding all of their links. Bassel Fares is the
multi-child parent for exercising the child picker: Adam is enrolled in `SCI101-A` only and Mira in
`MATH101-A` only, so the two children have different timetables, attendance, grades, and invoices
(Adam's is unpaid, Mira's paid).

## Production safeguard

The seed pathway is guarded before a single connection is opened
([`db/seeds/guard.ts`](../../db/seeds/guard.ts)), in two independent layers — either one aborts the
run with a non-zero exit code:

1. **Environment assertion.** `NODE_ENV === 'production'` or `APP_ENV === 'production'` throws
   `CRITICAL SAFETY VIOLATION: Seeding is strictly forbidden in production!`.
2. **Connection-host analysis.** The active connection string's host is parsed. A staging/production
   shape (`*.rds.amazonaws.com`, `*.rds.*`, or a host containing `prod`/`production`/`staging`/
   `stage`/`preprod`/`pre-prod`) is rejected unconditionally. Any host that is not a recognized local
   host (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, or the container names `postgres`, `db`,
   `database`, `host.docker.internal`) is rejected unless
   `SEED_ALLOW_NONLOCAL=true` is set for a disposable remote CI database.

The seed additionally connects as the administrative identity and runs as `studafy_admin` inside one
transaction; the runtime role `studafy_app` never seeds.

## Normalization compliance (3NF)

The seed inserts only into the normalized migration schema and therefore inherits its guarantees; it
introduces no denormalized copies. Every tenant row carries `school_id` and is wired through composite
foreign keys `(child_id, school_id) → parent(id, school_id)`, so a seeded row can never reference an
entity in another school. Representative mapping:

| Entity (table)         | Key                                                     | Non-key facts depend only on the key (3NF)                                            |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `users`                | `id`; natural `uq(school_id, normalized_email)`         | email/status/verification are attributes of the user; no role or profile copied in.   |
| `user_roles`           | `(school_id, user_id, role)`                            | Pure junction — no non-key attribute; a user↔role pair exists at most once.           |
| `oauth_identities`     | `id`; natural `uq(provider, subject)`                   | The external identity; the user link is a composite FK, not a duplicated user record. |
| `parent_child_links`   | `(school_id, parent_user_id, student_id)`               | `relationship` depends on the whole key; parenthood is a relationship, not a role.    |
| `enrollments`          | `(school_id, class_id, student_id)`                     | Junction; `status`/`enrolled_at` depend on the whole membership key.                  |
| `classes`              | `id`; natural `uq(school_id, code)`                     | course/term/teacher/room are composite FKs; no course or teacher name copied in.      |
| `attendance_records`   | `(id, created_at)`                                      | No `class_id`/`session_date` copied — both are FDs of `attendance_session_id`.        |
| `grades`               | `id`                                                    | Score/max/weight/label of one graded item; visibility derived from the submission.    |
| `material_chunks`      | `id`; natural `uq(school_id, material_id, chunk_index)` | Only the chunk's text/anchors/embedding; no material title or storage key copied.     |
| `ai_message_citations` | `(school_id, ai_message_id, citation_order)`            | Normalized junction (replaced the old `cited_chunk_ids` array in migration 000023).   |
| `invoice_cache`        | `id`; natural `uq(school_id, erpnext_docname)`          | Read-model mirror of an ERPNext document; ERPNext owns the ledger, not this cache.    |

`notification_preferences` are not seeded directly: the 000017 trigger populates the full
type × channel matrix when each user is created with status `active`, so the seed writes no derived
preference rows.

## Index health (proving the seeded indexes are usable)

`bun run db:seed:index-check` (also run automatically at the end of `db:seed`) reports two independent
signals against the seeded dataset — see
[`db/seeds/index-health.ts`](../../db/seeds/index-health.ts):

1. **Validity.** Every index in schema `app` must be `indisvalid AND indisready`. This catches, in
   particular, an `INVALID` index left behind by a failed `CREATE INDEX CONCURRENTLY` (migration
   000024 builds the `notification_preferences` index concurrently).
2. **Usability.** Representative tenant queries must be _served by an index_. Because the demo dataset
   is intentionally small, the planner would otherwise prefer a sequential scan purely on row count,
   which says nothing about index health. Each probe therefore runs with `enable_seqscan = off`: a
   valid, applicable index is then used, and a plan that still falls back to a `Seq Scan` means the
   index that should serve that access path is missing or unusable.

The probes and the index each is expected to use:

| Probe                           | Query shape                                                                      | Serving index                                      |
| ------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `notifications_unread`          | `WHERE school_id=$1 AND user_id=$2 AND read_at IS NULL ORDER BY created_at DESC` | `idx_notifications_school_user_unread` (partial)   |
| `enrollments_by_class`          | `WHERE school_id=$1 AND class_id=$2`                                             | `pk_enrollments` (school_id, class_id, student_id) |
| `material_chunks_by_material`   | `WHERE school_id=$1 AND material_id=$2 ORDER BY chunk_index`                     | `uq_material_chunks_material_chunk`                |
| `attendance_records_by_session` | `WHERE school_id=$1 AND attendance_session_id=$2`                                | `idx_attendance_records_school_session_student`    |

On success the check prints a single line, for example:

```text
Index health PASS: 120 app indexes valid and ready; 4 seed query probe(s) served by an index.
  [ok] notifications_unread: a user's unread notifications, newest first -> idx_notifications_school_user_unread
  [ok] enrollments_by_class: the roster of one class -> pk_enrollments
  [ok] material_chunks_by_material: one material's chunks in order -> uq_material_chunks_material_chunk
  [ok] attendance_records_by_session: one attendance session's records -> idx_attendance_records_school_session_student
```

(The exact index total depends on the migration set; the illustrative count above is not a fixed
value.) To capture the full `EXPLAIN (FORMAT JSON)` plans behind these probes, run the queries above
directly against the seeded database inside a transaction that sets `app.school_id` and
`SET LOCAL enable_seqscan = off`.

## Verifying the seed

An integration test at [`packages/db/tests/seed.test.ts`](../../packages/db/tests/seed.test.ts)
migrates a disposable database, seeds it, and asserts: the seed completes in under 2 seconds, 20+
tables are populated, every tenant row belongs to the single demo school, the trigger-seeded
preference matrix is exactly `users × 8 × 3`, the index health check passes, and a second run is a
no-op. It runs under `bun test` when `TEST_DATABASE_URL` is set (the same harness the migration tests
use), and is skipped otherwise. The guard unit tests in the same file run unconditionally.
