# Student, teacher, and guardian profile data model

ST-036 adds school-owned educational profiles. Authentication identity remains in `app.users`;
profile rows extend a same-school user without duplicating account or guardian contact data.

```mermaid
erDiagram
  SCHOOLS ||--o{ USERS : owns
  SCHOOLS ||--o{ STUDENTS : owns
  SCHOOLS ||--o{ TEACHERS : owns
  USERS ||--o| STUDENTS : "has student profile"
  USERS ||--o| TEACHERS : "has teacher profile"
  USERS ||--o{ PARENT_CHILD_LINKS : "parent/guardian"
  STUDENTS ||--o{ PARENT_CHILD_LINKS : child
  COUNTRIES ||--o{ STUDENTS : nationality

  STUDENTS {
    uuid id PK
    uuid school_id FK
    uuid user_id FK
    text admission_number
    text normalized_admission_number UK
    text first_name
    text middle_name
    text last_name
    text preferred_name
    date date_of_birth
    uuid nationality_country_id FK
    date admission_date
    student_status status
  }
  TEACHERS {
    uuid id PK
    uuid school_id FK
    uuid user_id FK
    text employee_number
    text normalized_employee_number UK
    teacher_employment_status employment_status
    date hire_date
    date termination_date
  }
  PARENT_CHILD_LINKS {
    uuid school_id PK_FK
    uuid parent_user_id PK_FK
    uuid student_id PK_FK
    parent_relationship relationship
  }
```

## Keys and tenant integrity

`students` and `teachers` have UUID primary keys plus `(id, school_id)` candidate keys for
tenant-safe child references. Their `(school_id, user_id)` keys make each user eligible for at most
one profile of each kind in a school. Composite foreign keys to `users(id, school_id)` guarantee
same-school identity linkage. `parent_child_links` uses the natural primary key
`(school_id, parent_user_id, student_id)`, so one canonical relationship row exists per pair; its
two composite foreign keys guarantee that both the parent user and student belong to that school.
Every foreign key uses `ON UPDATE RESTRICT ON DELETE RESTRICT`; deletion is always explicit.

## Lifecycle values

- Student: `applicant`, `enrolled`, `suspended`, `graduated`, `withdrawn`, `archived`.
- Teacher employment: `pending`, `active`, `on_leave`, `suspended`, `terminated`, `archived`.
- Parent relationship: `mother`, `father`, `guardian`, `step_parent`, `grandparent`, `sibling`,
  `other`.

The database validates the taxonomy and ensures a teacher termination date cannot precede, or
exist without, a hire date. Workflow transition authorization belongs to the application.

## Identifier and normalization review

Admission and employee numbers retain their trimmed display form. PostgreSQL generates a stored
`lower(btrim(...))` value, and a school-scoped unique constraint makes conflicts case-insensitive.
Clients never supply the generated column. Names and identifiers must be trimmed and non-empty;
nullable names are null rather than empty strings. Date of birth is a `date`, never mutable `age`.
Nationality references the global countries catalog. Plausibility and future-date rules are
application validation because policy may vary by school and time.

## Guardian contact strategy and privacy

The junction records only relationship facts. Guardian display name and email come from the linked
`users` row; there are no repeating `guardian_1` fields or stale contact snapshots. Phone and
emergency contact storage is deferred until a canonical user-contact model is approved. Custody,
pickup authorization, legal restrictions, and visibility rules are sensitive concepts requiring a
separate authorization/audit design; they must not be inferred from `relationship`.

Student names and demographics are educational/legal profile data distinct from
`users.display_name`. APIs should return only fields needed for the caller's authorized task and
must not log dates of birth or relationship data. Gender and preferred language are omitted until
approved taxonomies and collection purposes exist.

## RLS and grants

All three tables are owned by `studafy_admin`, grant only CRUD to `studafy_app`, revoke table/type
access from `PUBLIC`, and have the canonical permissive `FOR ALL TO PUBLIC` `tenant_isolation`
policy with both RLS flags enabled and forced. `PUBLIC` in a policy grants no table privilege.
Every runtime transaction must resolve an authorized school, set `app.school_id` with transaction
local scope, and commit or roll back before reusing the connection. Missing or malformed context
fails closed. RLS is tenant isolation; application roles still decide which profiles/actions a user
may access. There is no database `PARENT` role.

## Index rationale

Constraint indexes cover tenant admission/employee lookups, profile-to-user lookups,
parent-to-child traversal, tenant lists, and all composite referenced keys. The only additional
indexes are `(school_id, student_id, parent_user_id)` for child-to-guardian traversal and
`students(nationality_country_id)` for country parent update/delete checks. There are deliberately
no redundant school-only, status-only, date, name-search, or trigram indexes. Add future indexes
only from measured production query plans.

## Retention and future fields

No retention job or cascade is introduced. Profile archival/deletion and relationship history need
an approved retention, audit, and legal-hold policy before automation. Teacher employment history,
departments, job titles, employment types, student language/gender taxonomies, contacts, custody,
and emergency authorization are future domain models—not JSONB, arrays, or snapshot columns here.
