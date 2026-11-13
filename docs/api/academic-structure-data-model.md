# Academic structure data model

ST-037 separates academic catalog concepts from their delivery and enrollment relationships. Every
new table is owned by one school, carries `school_id`, and uses the canonical forced
`tenant_isolation` policy.

```mermaid
erDiagram
  SCHOOLS ||--o{ ACADEMIC_YEARS : owns
  SCHOOLS ||--o{ SUBJECTS : owns
  SCHOOLS ||--o{ ROOMS : owns
  ACADEMIC_YEARS ||--o{ TERMS : contains
  SUBJECTS ||--o{ COURSES : defines
  COURSES ||--o{ CLASSES : delivered_as
  ACADEMIC_YEARS ||--o{ CLASSES : schedules
  TERMS ||--o{ CLASSES : schedules
  TEACHERS ||--o{ CLASSES : leads
  ROOMS ||--o{ CLASSES : hosts
  STUDENTS ||--o{ ENROLLMENTS : receives
  CLASSES ||--o{ ENROLLMENTS : contains

  ACADEMIC_YEARS {
    uuid id PK
    uuid school_id FK_UK
    text code UK
    text name
    date starts_on
    date ends_on
    academic_period_status status
  }
  TERMS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid academic_year_id FK_UK
    text code UK
    smallint sequence_number UK
    date starts_on
    date ends_on
    academic_period_status status
  }
  SUBJECTS {
    uuid id PK_UK
    uuid school_id FK_UK
    text code UK
    text name
    catalog_status status
  }
  COURSES {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid subject_id FK
    text code UK
    text name
    catalog_status status
  }
  ROOMS {
    uuid id PK_UK
    uuid school_id FK_UK
    text code UK
    room_type room_type
    int capacity
    boolean is_active
  }
  CLASSES {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid course_id FK
    uuid academic_year_id FK
    uuid term_id FK
    uuid lead_teacher_id FK
    uuid room_id FK
    text code UK
    class_status status
  }
  ENROLLMENTS {
    uuid school_id PK_FK
    uuid class_id PK_FK
    uuid student_id PK_FK
    enrollment_status status
    timestamptz enrolled_at
    timestamptz withdrawn_at
  }
```

## Domain boundaries

- A subject is a school-owned academic domain. A course is a reusable school catalog offering based
  on one subject. A class is one concrete delivery of that course in a year and term.
- An academic year contains ordered terms. Database triggers keep term dates inside year dates and
  reject year-boundary changes that would invalidate a term. Terms may overlap.
- A class has one required lead teacher and room. Multiple teachers and meeting schedules require
  future junction and scheduling tables; they are not arrays or JSON fields.
- A room is physical or virtual. Physical rooms require a building and may have a floor; virtual
  rooms require an HTTPS URL and cannot carry physical location fields. Building/floor remain text
  until a building model is approved.
- An enrollment is the student/class relationship. Its natural key makes enrollment unique per
  school, class, and student. Grades, attendance, billing, and enrollment counts are not stored.

## Lifecycle and invariants

Academic years and terms use `planned`, `active`, `closed`, or `archived`. A partial unique index
allows at most one active academic year per school; state-transition authorization remains an
application concern. Subjects and courses use `draft`, `active`, `inactive`, or `archived`; classes
use `planned`, `active`, `completed`, or `cancelled`; enrollments use `active`, `waitlisted`,
`withdrawn`, `completed`, or `cancelled`. A withdrawn enrollment requires a withdrawal timestamp,
and other states forbid one.

Class codes are unique across a school. Course and subject codes are independently school-scoped;
term codes and sequence numbers are unique within an academic year. Capacity, when supplied, must
be positive. Class capacity is not automatically compared with room capacity or current enrollment.

## Tenant isolation

Composite foreign keys include `school_id` and reject cross-school relationships even for an
administrative role. The class-to-term key also includes `academic_year_id`, preventing a term from
being paired with a different year. Every table has RLS enabled and forced and the canonical
`tenant_isolation` policy. Missing or invalid `app.school_id` fails closed.

`studafy_admin` owns all objects; `studafy_app` receives table CRUD and enum usage only; PUBLIC has
no table or type access. RLS does not replace relational constraints or application authorization.
All foreign keys use `ON UPDATE RESTRICT ON DELETE RESTRICT`, so deletion and retention are explicit.
