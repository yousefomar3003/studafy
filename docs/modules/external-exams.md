# External exams and test scores

A school records the external exams its students sit beside its own grading: SAT, PSAT, ACT, AP,
IELTS, TOEFL iBT, IGCSE / A Level / IB Diploma final results, the national exams of Jordan
(Tawjihi) and Egypt (Thanaweya Amma), US state assessments, and any exam it defines itself.
Results can appear on transcripts.

- Plan: [`docs/plans/curriculum-support.md`](../plans/curriculum-support.md), WS-D
- Migration: `db/migrations/000255_create_external_exams.sql`
- Presets and rules: `packages/grading-engine/src/external-exams.ts`
- API: `apps/api/src/modules/external-exams` (tag "External exams")
- Web: Academic setup › External exams (`ExternalExamsTab.tsx`); the student page's "Test scores"
  panel (`TestScoresPanel.tsx`); the transcript's "External examinations" section
- Mobile: "Test scores" on the results screen, for the student and for a parent's child
  (`features/student/presentation/widgets/test_scores_section.dart`)

Students are entered for these exams through [exam entries](exam-entries.md) (sessions,
candidate numbers, the board's entry list); a result can link back to its entry (`entry_id`).

The feature is opt-in: a school that adds no exam sees an empty tab and an empty panel, and its
transcripts are unchanged.

## Data model

| Table                               | One row per                                                  |
| ----------------------------------- | ------------------------------------------------------------ |
| `app.external_exams`                | exam in the school's catalogue: code, name, total rule       |
| `app.external_exam_components`      | scored part of an exam: numeric range and step, or labels    |
| `app.student_external_exam_results` | sitting of an exam by a student (optionally for one subject) |
| `app.student_external_exam_scores`  | score of a result in one component                           |

- **Exam**: `code` (unique per school, case-insensitively), `name`, `preset_key` (the preset it was
  copied from, or null), `total_mode` (`sum`, `average` or `none`), `total_rounding_step` (an
  average rounded to the nearest multiple, halves up: IELTS rounds to 0.5), `total_min` /
  `total_max` (shown beside the total), `per_subject` (one result per subject: IGCSE, A Level,
  IB DP, AP, state tests), `show_on_transcript`, `archived_at`. Exams are archived, never deleted.
- **Component**: `score_type` `numeric` (`min_score`, `max_score`, `step`) or `label`
  (`allowed_labels`, an ordered `text[]`, approved in `db/policies/rls-coverage.ts`). A CHECK keeps
  each type's columns consistent.
- **Result**: `student_id`, `exam_id`, `subject_id` (required for a per-subject exam, absent
  otherwise — enforced by the API), `sat_on`, `total_score` (computed), `note`,
  `recorded_by_user_id`. Several sittings of the same exam are allowed.
- **Score**: `numeric_score` or `label_score` (exactly one). Composite foreign keys hold a score to a
  component of the result's own exam and to the result's student; deleting a result deletes its
  scores.

## Rules

All validation and totals are pure functions in `@studafy/grading-engine`, used by the API and by
the web form as the user types:

- `validateExternalExamDefinition`: code and name lengths, 1–20 components with distinct names, a
  numeric range that is a whole number of steps, 1–50 distinct labels, and a sum or average only
  over numeric components.
- `validateExternalExamScore`: a number in range and on the step, or exactly one of the allowed
  labels.
- `computeExternalExamTotal`: `sum` (two decimals), `average` (rounded to the step, else two
  decimals) or none. **The total is only worked out when every component has a numeric score**;
  a result scored on part of an exam is stored with no total. The client never sends a total.

Once an exam has results, its total mode, rounding step and per-subject setting, and the scoring
rule of every component that has scores, are locked (409), and a scored component cannot be
removed. Names, the code, the total's displayed range and `show_on_transcript` stay editable, and
new components can be added.

## Presets

Presets are code, copied into a school's catalogue on demand and fully editable afterwards. Adding
the same preset twice needs another code (`code` override); the web sends the preset's name in the
viewer's language (`name` override), so an Arabic-speaking school gets "التوجيهي".

| Key                | Code        | Components                                                           | Total            | Per subject |
| ------------------ | ----------- | -------------------------------------------------------------------- | ---------------- | ----------- |
| `sat`              | `SAT`       | Reading and Writing, Math: 200–800 step 10                           | sum, 400–1600    | no          |
| `psat`             | `PSAT`      | Reading and Writing, Math: 160–760 step 10                           | sum, 320–1520    | no          |
| `act`              | `ACT`       | English, Mathematics, Reading, Science: 1–36                         | average to 1     | no          |
| `ap`               | `AP`        | Score 1–5                                                            | none             | yes         |
| `ielts`            | `IELTS`     | Listening, Reading, Writing, Speaking: 0–9 step 0.5                  | average to 0.5   | no          |
| `toefl_ibt`        | `TOEFL`     | Reading, Listening, Speaking, Writing: 0–30                          | sum, 0–120       | no          |
| `igcse_letter`     | `IGCSE`     | Grade A\*, A … G, U                                                  | none             | yes         |
| `igcse_numeric`    | `IGCSE-9-1` | Grade 9 … 1, U                                                       | none             | yes         |
| `a_level`          | `A-LEVEL`   | Grade A\*, A … E, U                                                  | none             | yes         |
| `ib_dp`            | `IB-DP`     | Grade 1–7                                                            | none             | yes         |
| `tawjihi`          | `TAWJIHI`   | Six default subjects, each 0–100 step 0.5                            | average, 0–100 % | no          |
| `thanaweya_amma`   | `THANAWEYA` | Six default subjects, each 0–100 step 0.5                            | sum, 0–600       | no          |
| `state_assessment` | `STATE`     | Performance level (Level 1 … Level 4); Scale score 0–1000 (optional) | none             | yes         |

Presets whose defaults are not an official, stable scale carry a `note` (returned by
`GET /api/grading/external-exam-presets`, shown and translated in the web):

- **TOEFL iBT** is moving to a 1–6 band scale; the 0–30 sections are the long-standing defaults.
- **Tawjihi** (Jordan, General Secondary Education Certificate): one result per student with a mark
  per subject; the total is the plain **average percentage** of the subject marks. The default
  subjects (Arabic Language, English Language, Islamic Education, History of Jordan, Mathematics,
  "Stream subject") and the 0–100 maximums are editable defaults, not the ministry's official
  configuration, which varies by stream and year. The ministry's weighting of subjects is not
  applied. A school with several streams can add the preset once per stream under different codes.
- **Thanaweya Amma** (Egypt, General Secondary Certificate): one result per student with a mark per
  subject, totalled (`sum`). The exam reports a total and a percentage; the data model stores one
  computed total, so the **percentage is total ÷ `total_max`** and is not stored separately. The
  default subjects ("Arabic Language", "First Foreign Language", "Second Foreign Language", three
  "Track subject" placeholders), their 0–100 maximums and the 600 total maximum are editable
  defaults: the ministry changes subjects and maximums, so the school sets them for the student's
  track and year.
- **State assessment** (US): per subject, a performance level and an optional scale score. The
  levels and the scale-score range differ by state and subject; the school renames the exam after
  its state's test and edits them.

## Access

| Who                                            | Catalogue                             | A student's results            |
| ---------------------------------------------- | ------------------------------------- | ------------------------------ |
| School leadership (ORG_ADMIN, PRINCIPAL, SA)   | read, create, edit, archive / restore | read, record, edit, delete     |
| Teachers (`academicConfig:read`, `grade:read`) | read                                  | read, for students they teach  |
| The student; linked parents (`grade:read`)     | —                                     | read their own / their child's |

No permission was added: managing uses `academicConfig:manage`, the catalogue is read with
`academicConfig:read`, results with `grade:read`. Row scope is `app.can_read_student` (leadership,
a teacher of the student, the student, linked parents), enforced both by the API (403, or 404 for a
student outside the school) and by the restrictive `role_scope_visibility` policy on results and
scores. The catalogue is configuration, so it has tenant isolation only.

`app.subjects` is role-scoped, so a student or parent may not see an IGCSE subject they take no
class in. `app.external_exam_result_subjects(student_id)` (SECURITY DEFINER, checks
`app.can_read_student` itself) returns only the subjects of that student's results, so the name
shows beside the result without widening `app.subjects`.

Every write is audited (`external_exams`, `student_external_exam_results`) with old and new values.

## API

| Method | Path                                                      | Permission               |
| ------ | --------------------------------------------------------- | ------------------------ |
| GET    | `/api/grading/external-exam-presets`                      | `academicConfig:read`    |
| GET    | `/api/grading/external-exams?include_archived=`           | `academicConfig:read`    |
| POST   | `/api/grading/external-exams`                             | `academicConfig:manage`  |
| POST   | `/api/grading/external-exams/from-preset`                 | `academicConfig:manage`  |
| PUT    | `/api/grading/external-exams/{examId}`                    | `academicConfig:manage`  |
| POST   | `/api/grading/external-exams/{examId}/archive`            | `academicConfig:manage`  |
| POST   | `/api/grading/external-exams/{examId}/restore`            | `academicConfig:manage`  |
| GET    | `/api/grading/students/{studentId}/external-exam-results` | `grade:read` + row scope |
| POST   | `/api/grading/students/{studentId}/external-exam-results` | `academicConfig:manage`  |
| PUT    | `/api/grading/external-exam-results/{resultId}`           | `academicConfig:manage`  |
| DELETE | `/api/grading/external-exam-results/{resultId}`           | `academicConfig:manage`  |

`PUT` on an exam replaces its definition: components with an `id` are updated, new ones added,
missing ones removed. `PUT` on a result replaces its subject, date, note and scores; the exam
stays.

## Transcripts

When a transcript is issued (or reissued), the results of every exam with `show_on_transcript` are
copied into a separate top-level `external_exams` section of its `content`: per exam (by name) its
code, name, total maximum and every sitting oldest first, with subject, date, total and each
component's score. The section is omitted when there is nothing to show, so transcripts of schools
not using the feature are unchanged, and documents issued before it render as before. Later edits
or deletions never reach an issued transcript; they are picked up by a reissue. Recording a new
test score does not mark a transcript as needing a reissue (`needs_reissue` still tracks only
finalized results).

## Privacy

Results and scores carry `student_id`, so the GDPR pipeline's catalog-driven discovery
(`apps/workers/src/queues/maintenance/tenant-tables.ts`) includes them in a student's export and
erasure walk with no registry change. On erasure the row is kept (the school's record) and its
`note` column, a personal-data column by name (`retention-registry.ts`), is set to NULL.
