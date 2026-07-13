# Assessment and material database design

Migration `000011_create_assignments_submissions_exams_materials.sql` adds five school-owned
tables under `app`: class assignments, one current submission per student, class exams, one
placeholder result per student, and class materials backed by object storage. SQL constraints are
the source of truth; forced RLS is a visibility boundary, not a substitute for authorization or
relational integrity.

## Keys, dependencies, and normalization

| Table                    | Primary and candidate keys                                        | Principal dependency                                                                |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `assignments`            | `id`; `(id, school_id)`                                           | ID determines its class, content, lifecycle, scoring, actors, and timestamps.       |
| `assignment_submissions` | `id`; `(id, school_id)`; `(school_id, assignment_id, student_id)` | The student-assignment relationship determines submission, grading, and audit data. |
| `exams`                  | `id`; `(id, school_id)`                                           | ID determines its class, schedule, lifecycle, scoring, actors, and timestamps.      |
| `exam_results`           | `id`; `(id, school_id)`; `(school_id, exam_id, student_id)`       | The student-exam relationship determines the placeholder outcome and audit data.    |
| `materials`              | `id`; `(id, school_id)`; globally unique `storage_key`            | ID determines one class-owned object's metadata, visibility, and ingestion state.   |

Every value is atomic. Relationships are foreign keys rather than arrays or JSONB (1NF).
Submission and result attributes depend on their complete student/assessment relationship (2NF).
Class, course, term, student, school, assignment, and exam facts remain in their owning tables;
names, counts, averages, ranks, and other derived facts are not copied (3NF). There is no deliberate
denormalization. The material row temporarily owns file metadata because no canonical storage-object
table exists; a later migration may move it without changing the assessment relationships.

All five tables directly reference `schools(id)`. Every tenant-owned reference includes
`school_id`, including classes, students, assignments, exams, and user actors. All foreign keys use
`ON UPDATE RESTRICT ON DELETE RESTRICT`: retention and deletion require explicit dependent cleanup,
and no school deletion cascades through academic records.

## Lifecycles and application responsibilities

- Assignments use `draft`, `published`, `closed`, or `archived`. Draft rows have no `assigned_at`;
  every other state requires it. Availability, assignment, and due timestamps cannot be ordered
  after the due timestamp.
- Submissions use `draft`, `submitted`, `late`, `graded`, `returned`, or `withdrawn`. Submitted,
  late, and returned rows require `submitted_at`; graded rows additionally require a nonnegative
  exact score, grader, and ordered `graded_at`.
- Exams use `draft`, `scheduled`, `open`, `closed`, `cancelled`, or `archived`, with one authoritative
  start/end range and a positive `numeric(10,2)` maximum score.
- Results use `pending`, `graded`, `published`, `withheld`, or `voided`. Grading and publication
  fields change as complete actor/timestamp groups, and publication cannot predate grading.
- Materials use exactly `uploaded`, `processing`, `ready`, or `failed`. Uploaded/processing rows
  have neither completion nor error metadata; ready rows require `ingested_at`; failed rows require
  a non-empty `ingest_error`.

`late` and `open` are stored workflow states chosen by the service. A scheduler or command handler
must synchronize them with timestamps; there are intentionally no clock-dependent checks or
transition triggers. Status enums and static state checks prevent malformed rows but do not
authorize transitions.

The database does not compare submission/result scores with the parent maximum because PostgreSQL
checks cannot safely reference other rows. It also does not assert active class enrollment when a
submission or result is written. Transactional application services must enforce both rules. The
database does enforce that every referenced assessment, student, class, and actor belongs to the
same school.

Actor columns record operational attribution: assignment/exam creators, material uploaders,
last editors, graders, and result publishers. They are not an immutable audit log; a future audit
or outbox model is required for historical change records.

## Material storage and AI behavior

A material belongs to exactly one concrete class. Assignment/exam-specific attachments, reuse
across classes, submission attachments, and shared files require future normalized junction and
storage-object tables; no generic `entity_type`/`entity_id` pair is used.

`storage_key` identifies one object in the `app-files` bucket and is globally unique. It must match
`permanent/<school_id>/<objectId>/<filename>`, following the repository storage convention. The
database stores the original filename, MIME type, byte size, and optional lowercase SHA-256 digest,
but never file bytes, signed URLs, access tokens, or credentials. Clients should receive authorized
short-lived access from a server-side storage service rather than the internal key directly.

`ai_visible` is non-null and defaults to `false`. It is an explicit ingestion/retrieval eligibility
signal, not authorization and not a cross-tenant access mechanism. Changing it does not itself
enqueue work or remove indexed content; a future AI pipeline must perform authorized, tenant-scoped
reprocessing or deletion. Chunks, embeddings, extracted bodies, and model output are out of scope.

## Index rationale and security

- `(school_id, class_id, due_at, id)` lists class assignments and backs the class reference.
- Submission uniqueness serves exact/student-per-assignment lookup; the reverse student index serves
  student history; `(school_id, status, submitted_at, id)` serves the grading queue.
- `(school_id, class_id, starts_at, id)` lists scheduled class exams.
- Result uniqueness serves exam rosters/exact lookup; the reverse student index serves result history.
- Material class/creation ordering serves class content; ingestion status/creation ordering serves
  the established `ai-ingestion` worker queue.
- Tenant-leading actor indexes support attribution queries and restricted parent-user operations.

No title, boolean-only, status-only, redundant school-only, or speculative AI-ready index is added.
All tenant query indexes lead with `school_id`; the RLS expression casts the setting rather than the
indexed column.

`studafy_admin` owns every table, enum, constraint, index, and policy. `studafy_app` receives explicit
table CRUD and enum usage only; PUBLIC receives no object access. The canonical
`app.apply_tenant_isolation` helper enables and forces RLS on all five tables. Missing or malformed
`app.school_id` fails closed, and runtime roles cannot disable RLS or alter policies/schema objects.

## Future extensions

Multiple submission/exam attempts would extend the relationship candidate keys with an attempt
number. Rubrics, question-level answers, analytics, result ranking, submission attachments,
material reuse, canonical file objects, AI chunks/embeddings, retention automation, and immutable
audit history each require separate normalized models.
