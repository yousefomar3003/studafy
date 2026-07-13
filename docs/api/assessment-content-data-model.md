# Assessment and content data model

ST-039 adds class-scoped assignments, submissions, exams, result placeholders, and educational
materials. Every new entity is school-owned, uses composite tenant-safe references, and has forced
canonical RLS.

```mermaid
erDiagram
  SCHOOLS ||--o{ COURSES : owns
  SCHOOLS ||--o{ CLASSES : owns
  SCHOOLS ||--o{ STUDENTS : owns
  COURSES ||--o{ CLASSES : delivered_as
  TERMS ||--o{ CLASSES : schedules
  CLASSES ||--o{ ASSIGNMENTS : receives
  ASSIGNMENTS ||--o{ ASSIGNMENT_SUBMISSIONS : receives
  STUDENTS ||--o{ ASSIGNMENT_SUBMISSIONS : creates
  CLASSES ||--o{ EXAMS : receives
  EXAMS ||--o{ EXAM_RESULTS : produces
  STUDENTS ||--o{ EXAM_RESULTS : receives
  CLASSES ||--o{ MATERIALS : contains

  ASSIGNMENTS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid class_id FK
    uuid created_by_user_id FK
    uuid last_edited_by_user_id FK
    text title
    assignment_status status
    timestamptz available_from
    timestamptz assigned_at
    timestamptz due_at
    numeric max_score
    boolean allow_late_submission
  }
  ASSIGNMENT_SUBMISSIONS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid assignment_id FK_UK
    uuid student_id FK_UK
    uuid last_edited_by_user_id FK
    uuid graded_by_user_id FK
    assignment_submission_status status
    timestamptz submitted_at
    timestamptz graded_at
    numeric score
  }
  EXAMS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid class_id FK
    uuid created_by_user_id FK
    uuid last_edited_by_user_id FK
    text title
    exam_status status
    timestamptz starts_at
    timestamptz ends_at
    numeric max_score
  }
  EXAM_RESULTS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid exam_id FK_UK
    uuid student_id FK_UK
    uuid graded_by_user_id FK
    uuid published_by_user_id FK
    exam_result_status status
    numeric score
    timestamptz graded_at
    timestamptz published_at
  }
  MATERIALS {
    uuid id PK_UK
    uuid school_id FK_UK
    uuid class_id FK
    uuid uploaded_by_user_id FK
    uuid last_edited_by_user_id FK
    text storage_key UK
    boolean ai_visible
    material_ingest_status ingest_status
    timestamptz ingested_at
  }
```

`ASSIGNMENT_SUBMISSIONS` is unique by `(school_id, assignment_id, student_id)` and `EXAM_RESULTS`
is unique by `(school_id, exam_id, student_id)`. These candidate keys permit one current row per
student/assessment; multiple attempts are not modeled. Each FK shown between school-owned entities
also includes `school_id`, even where Mermaid displays the relationship compactly.

Materials belong to one class and reference permanent object storage; file bytes remain outside
PostgreSQL. `ai_visible` defaults to false and does not replace authorization. Ingestion supports
only `uploaded`, `processing`, `ready`, and `failed`. Assignment/exam material junctions, submission
attachments, file-object normalization, AI chunks, and embeddings are future models.

All five tables are owned by `studafy_admin`, grant controlled CRUD to `studafy_app`, and have RLS
enabled and forced with `tenant_isolation`. Application permission checks still decide who may
create, submit, grade, publish, upload, or expose material to AI.
