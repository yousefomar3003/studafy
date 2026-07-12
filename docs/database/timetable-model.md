# Timetable database design

Migration `000010_create_timetable_tables.sql` adds two school-owned tables under the `app` schema:
`timetable_versions` (a proposed weekly schedule for one term, moving through an approval state
machine) and `timetable_slots` (one weekly-recurring class occurrence: class, teacher, room,
weekday, period). It depends on the academic structure tables from
[`000009`](../../db/migrations/000009_create_academic_structure_tables.sql)
(`academic_years`, `terms`, `classes`, `teachers`, `rooms`) and on `app.users` from
[`000007`](../../db/migrations/000007_create_users_and_identity_tables.sql). SQL constraints are the
source of truth; APIs must not weaken them or treat RLS as a substitute for permission checks.

## Keys and functional dependencies

| Table                | Primary and candidate keys                            | Principal dependencies                                                                    |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `timetable_versions` | `id`; `(id, school_id)`; `(school_id, term_id, name)` | ID determines its year, term, name, approval status, and the four submit/approve columns. |
| `timetable_slots`    | `id`                                                  | ID determines its version, class, teacher, room, weekday, and period.                     |

`timetable_slots` has no further natural/candidate key: the two `EXCLUDE` constraints (see below)
are integrity guards over overlapping combinations, not an alternate identity for the row, so they
are not modeled as `UNIQUE`/candidate keys. No table in this migration is referenced by a later
composite foreign key, so `timetable_slots` does not carry a speculative `(id, school_id)` unique
constraint the way `timetable_versions` does (needed because `timetable_slots` references it
compositely).

All values are atomic; there are no arrays, repeating groups, or JSONB relationships (1NF). Every
non-key column in both tables depends on the whole primary key, not a subset of it — neither table
has a composite primary key (2NF is trivially satisfied). Slot facts (class, teacher, room, weekday,
period) live only on `timetable_slots`; version facts (name, status, submission/approval audit) live
only on `timetable_versions`; nothing is copied from `academic_years`, `terms`, `classes`,
`teachers`, or `rooms` (3NF). `academic_year_id` is kept on `timetable_versions` alongside `term_id`
for the same reason `app.classes` keeps it alongside its own `term_id`: it is not a free-floating
denormalization, it is pinned by `fk_timetable_versions_term`'s composite reference to
`app.terms (id, academic_year_id, school_id)`, so it cannot drift from the term's real year.

## The approval state machine

`status` is `draft` → `pending` → `approved`, with `pending` → `draft` as the one backward edge (a
reviewer sending a submission back). There is no `rejected` state: rejection is expressed by moving
a `pending` version back to `draft`, where it can be edited and resubmitted.

The state machine is not just the enum — it is enforced by
`app.enforce_timetable_version_transition()` (`BEFORE INSERT OR UPDATE OF status`):

- A version must be **inserted** as `draft`. There is no direct path to create a version that is
  already `pending` or `approved`.
- `draft → pending` requires `submitted_by_user_id` in the same statement and stamps
  `submitted_at := now()` itself — the caller cannot backdate or omit it.
- `pending → approved` requires `approved_by_user_id` and stamps `approved_at := now()` itself.
- `pending → draft` clears all four submit/approve columns.
- Every other transition (including skipping straight from `draft` to `approved`, or moving out of
  `approved`) raises `23514`.
- The trigger also fires on any update to the four audit columns themselves, even when `status` is
  left alone, and rejects it: `submitted_at`/`submitted_by_user_id`/`approved_at`/`approved_by_user_id`
  can only ever change together with the status transition that produces them, never by a
  standalone `UPDATE`.

`ck_timetable_versions_submission_state` is the complementary **static** invariant: for whichever
status a row is in, right now, the presence of `submitted_at`/`submitted_by_user_id` and
`approved_at`/`approved_by_user_id` is pinned exactly to that status, and `approved_at >=
submitted_at` when both are set. The trigger enforces valid _transitions_; the check constraint
enforces the resulting _state_ is never inconsistent, including for any write path the trigger did
not anticipate. `approved` is deliberately terminal for a given version: producing a new schedule
means creating a new `timetable_versions` row (a new draft), not reopening an approved one. Only one
version per `(school_id, term_id)` may be `approved` at a time (`uq_timetable_versions_one_approved_per_term`,
a partial unique index, mirroring `uq_academic_years_one_active_per_school` in `000009`).

## Slot integrity

Two triggers on `timetable_slots` complete the model:

- `enforce_timetable_slot_class_term()` (`BEFORE INSERT OR UPDATE OF class_id, timetable_version_id,
school_id`) locks and reads the parent version and the referenced class, then rejects the write if
  the class's `(term_id, academic_year_id)` does not match the version's — the same
  lock-then-check shape as `000009`'s `enforce_term_within_academic_year`. Composite foreign keys
  alone cannot express this cross-row rule.
- `enforce_timetable_slot_version_editable()` (`BEFORE INSERT OR UPDATE OR DELETE`) rejects any slot
  write whose version is not `draft`. Without this, `pending`/`approved` schedules could still be
  edited underneath the approval they represent, which would make the state machine above cosmetic.
  It raises `55000` (`object_not_in_prerequisite_state`), distinct from the `23514` used for the
  version state machine itself.

`teacher_id` and `room_id` are stated on the slot rather than derived from `app.classes` because a
slot may legitimately use a substitute teacher or an overflow room for one period; `class_id` still
ties the slot back to the enrollment/capacity model in `000009`.

## Overlap: why `EXCLUDE`, not `UNIQUE`

`timetable_slots` has no period-duration column — `period` is a single discrete slot number, not a
range — so within one timetable version, two slots "overlap" for a teacher or a room exactly when
they share `(weekday, period)`. That is expressible as two ordinary partial-free `UNIQUE`
constraints. This migration uses `EXCLUDE USING gist` instead, for one deliberate reason: the ticket
requires overlap-exclusion behavior on both `teacher_id` and `room_id` independently, and `EXCLUDE`
is the constraint type PostgreSQL provides for "no two rows may share these keys under this
operator," which generalizes without a rewrite if a future migration adds a real range (double
periods, start/end times) — at that point only the operator on one column changes (`=` to `&&`), not
the constraint type. `btree_gist` (enabled by this same migration; see
[extensions.md](./extensions.md#btree_gist--approved-use-case)) supplies the GiST equality opclasses
for `uuid` and `smallint` that `EXCLUDE` needs.

- `ex_timetable_slots_teacher_weekday_period`: no two rows in the same `(school_id,
timetable_version_id)` may share `(teacher_id, weekday, period)`.
- `ex_timetable_slots_room_weekday_period`: same, for `room_id`.

Both are scoped by `timetable_version_id`, not just `school_id`: two different drafts (or a draft and
the currently approved version) are independent proposals and may legitimately schedule the same
teacher differently. Only `uq_timetable_versions_one_approved_per_term` guarantees a single school
has one live, approved schedule per term at a time.

## Index rationale

Primary/unique constraints and the two `EXCLUDE` constraints (which are GiST indexes) cover slot
identity and the teacher/room overlap guards themselves. Additional indexes are limited to:

- `uq_timetable_versions_one_approved_per_term`: enforces and retrieves the live schedule for a term.
- `idx_timetable_versions_school_academic_year_id`, `idx_timetable_versions_school_term_id`: list a
  school's versions by year or term and back their composite foreign-key parent-delete checks.
- `idx_timetable_versions_school_submitted_by`, `idx_timetable_versions_school_approved_by`: back the
  two nullable composite foreign keys to `app.users` (parent update/delete checks) and support "what
  has this reviewer submitted/approved" lookups.
- `idx_timetable_slots_school_version_id`: backs the version foreign key and is the primary "render
  one version's whole timetable" query.
- `idx_timetable_slots_school_class_id`: backs the class foreign key and "this class's weekly
  periods" query.

No separate `teacher_id`-only or `room_id`-only index is added on `timetable_slots`: the two
`EXCLUDE` GiST indexes already lead with `(school_id, timetable_version_id, teacher_id, ...)` and
`(school_id, timetable_version_id, room_id, ...)`, which is the query shape that matters (one
version's teacher/room load), so a duplicate btree index would only add write amplification without
serving an unmet query. All tenant indexes lead with `school_id`; the RLS policy still casts the GUC
rather than relying on the indexed column.

## Ownership, security, and known gaps

`studafy_admin` owns both tables, the enum, the three trigger functions, and every index/constraint;
`studafy_app` has explicit CRUD plus enum `USAGE` and cannot invoke the trigger functions directly or
touch RLS/schema objects. `PUBLIC` has no object privileges. Canonical forced RLS
(`app.apply_tenant_isolation`) isolates tenants and fails closed exactly as in `000009`.

Not built here, and deliberately out of scope for this migration:

- No `periods` table (start/end wall-clock time per period number). `period` is an opaque
  school-defined ordinal; a future migration that adds real period times would extend the `EXCLUDE`
  operator as described above rather than changing the table shape.
- No teacher availability/absence model — a teacher can be scheduled into a slot regardless of leave
  or contracted hours; that is a separate, not-yet-designed concern.
- No "is this term's schedule complete" check gates `pending → approved`; approval only requires an
  actor, not full coverage of every class.
- `timetable_versions.academic_year_id`/`term_id` are immutable-in-practice (no trigger blocks
  changing them once slots exist, unlike `000009`'s year/term date-shrink guard); `fk_timetable_slots_class`
  and the class-term trigger make changing them without also breaking existing slots very difficult
  in practice, but there is no explicit guard. Add one if this proves to be a real operational path.
