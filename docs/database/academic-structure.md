# Academic structure database design

Migration `000009_create_academic_structure_tables.sql` adds seven school-owned tables under the
`app` schema. SQL constraints are the source of truth; APIs must not weaken them or treat RLS as a
substitute for permission checks.

## Keys and functional dependencies

| Table            | Primary and candidate keys                                               | Principal dependencies                                                             |
| ---------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `academic_years` | `id`; `(id, school_id)`; `(school_id, code)`                             | ID determines school, code, name, dates, status, and timestamps.                   |
| `terms`          | `id`; `(id, academic_year_id, school_id)`; year-scoped code and sequence | ID determines its school, year, descriptive fields, dates, status, and timestamps. |
| `subjects`       | `id`; `(id, school_id)`; `(school_id, code)`                             | ID determines the school-owned subject attributes.                                 |
| `courses`        | `id`; `(id, school_id)`; `(school_id, code)`                             | ID determines its subject and catalog attributes.                                  |
| `rooms`          | `id`; `(id, school_id)`; `(school_id, code)`                             | ID determines room type, location, capacity, availability, and timestamps.         |
| `classes`        | `id`; `(id, school_id)`; `(school_id, code)`                             | ID determines its course, period, lead teacher, room, capacity, and status.        |
| `enrollments`    | `(school_id, class_id, student_id)`                                      | The complete relationship key determines status and lifecycle timestamps.          |

All ordinary relationships are foreign keys. Values are atomic, and there are no arrays, repeating
groups, or JSONB relationships (1NF). Enrollment attributes depend on its complete natural key
(2NF). Year, term, subject, course, class, room, student, and teacher facts remain in their owning
relations, with no derived enrollment totals or copied names (3NF). There is no deliberate
denormalization.

## Composite integrity and lifecycle

Every table directly references `schools(id)`. Terms reference `(academic_year_id, school_id)`;
courses reference `(subject_id, school_id)`; classes use tenant-safe course, year, teacher, and room
keys plus `(term_id, academic_year_id, school_id)`; enrollments reference tenant-safe class and
student keys. All use restricted update/delete behavior.

Term/year containment is cross-row integrity and cannot be expressed by a PostgreSQL check
constraint. A term trigger locks and reads its parent year before accepting dates. A complementary
year trigger rejects boundary updates that would strand existing terms. Static checks still enforce
strict date ordering without mutable `CURRENT_DATE` predicates.

Only one academic year may have status `active` per school. The database constrains valid status
values but does not authorize or automatically perform transitions. Enrollment withdrawal state and
timestamp remain mutually consistent. Retention, audit history, and automatic archival require a
separate approved policy.

## Index rationale

Primary/unique constraints cover tenant codes, entity references, ordered terms, students in a
class, and code-ordered class pagination. Additional indexes are limited to:

- `uq_academic_years_one_active_per_school`: enforces and retrieves the active year.
- `idx_courses_school_subject_id`: lists a school's courses for a subject.
- The five `idx_classes_school_*` indexes: list classes by year, term, course, lead teacher, or room
  and support parent update/delete checks.
- `idx_enrollments_school_student_class`: reverse traversal from student to classes.

All tenant query indexes lead with `school_id`; the RLS policy casts the GUC rather than the indexed
column. There are no status-only, room-type, capacity, fuzzy-search, or redundant school-only
indexes. Query-plan tests disable sequential scans only to verify eligibility on small fixtures;
they make no production performance claim.

## Ownership, security, and future extensions

`studafy_admin` owns tables, types, functions, triggers, policies, and indexes. `studafy_app` has
explicit CRUD plus enum usage, cannot invoke the trigger helpers directly, and cannot change schema
or RLS objects. PUBLIC has no object privileges. Canonical forced RLS isolates tenants and fails
closed when context is absent or malformed.

Future normalized models should cover buildings, multi-teacher assignments, meetings/timetables,
attendance, grading, and audit history. Capacity enforcement needs a concurrency-safe transactional
service; class/room capacity and enrollment counts intentionally remain independent today.
