# Exam entries

A school enters its students for the external exams in its catalogue
([external exams](external-exams.md)): it runs a **session** of an exam ("IGCSE May/June 2027")
and **enters** students into it with the subjects they sit, their tier where the exam has one, a
candidate number and a status, then sends the entry list to the exam board. Students and parents
see the entries in the app. Results recorded later can point back at the entry they came from. No
fees are handled here.

- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-I
- Migration: `db/migrations/000261_create_external_exam_entries.sql`
- Rules: `packages/grading-engine/src/exam-entries.ts` (`canChangeExamEntryStatus`,
  `nextCandidateNumbers`)
- API: `apps/api/src/modules/exam-entries` (tag "Exam entries"); the result link in
  `apps/api/src/modules/external-exams`
- Web: Academic setup › Exam entries (`ExamEntriesTab.tsx`, leadership); the "Exam entry" choice
  when recording a result on the student page (`TestScoresPanel.tsx`)
- Mobile: "Exam entries" on the results screen, for the student and for a parent's child
  (`features/student/presentation/widgets/exam_entries_section.dart`)

The feature is opt-in: a school that adds no session sees an empty tab, nothing in the apps, and
its results are unchanged.

## Data model

| Table                              | One row per                                                 |
| ---------------------------------- | ----------------------------------------------------------- |
| `app.external_exam_sessions`       | session of a catalogue exam: series and dates               |
| `app.external_exam_entries`        | student entered for a session: candidate number, status     |
| `app.external_exam_entry_subjects` | subject an entry covers, with its tier and the board's code |

- **Session**: `exam_id`, `series` (the board's name, unique per exam whatever its case),
  `entry_deadline`, `starts_on` / `ends_on` (first and last exam; a last date needs a first one),
  `results_date`, `note`. A session can be deleted only while nobody is entered in it.
- **Entry**: one per student per session. `candidate_number` (≤ 20, unique within the session
  whatever its case; a withdrawn entry keeps its number), `status`, `entered_at`, `withdrawn_at`,
  `note`, `created_by_user_id`. `exam_id` is carried so a result can be held to an entry of its own
  exam.
- **Entry subject**: `subject_id` (once per entry), `tier` (≤ 40: Core, Extended, Foundation,
  Higher), `option_code` (≤ 40: the board's syllabus or option code, 0580, 9709/12). A per-subject
  exam (IGCSE, A Level, AP) is entered with at least one subject; any other (IELTS, SAT) with none.
- **Result link**: `app.student_external_exam_results.entry_id` (nullable). The composite key
  `(entry_id, student_id, exam_id, school_id)` holds a result to an entry of its own student and
  exam; an entry with results cannot be deleted.

## Status

`draft` → `entered` → `withdrawn`, and a withdrawn entry can be reinstated as `entered`
(`canChangeExamEntryStatus`). A CHECK keeps the stamps consistent: a draft has neither, an entered
entry `entered_at`, a withdrawn one both.

- **draft**: the school is still planning; nothing has been sent to the board. Only a draft can be
  deleted. Drafts are not shown to students and parents.
- **entered**: sent to the board.
- **withdrawn**: withdrawn after being entered. It is kept, skipped by bulk entry and still in the
  board export (with its status).

Changing the status of several entries is all or nothing: one entry that cannot move (a draft
withdrawn, anything moved back to draft) refuses the whole request (409). Entries already in the
status are left alone.

## Entering students

`POST .../{sessionId}/entries` takes any of `student_ids`, a `section_id` (its enrolled students)
and a `grade_level_id` with its `academic_year_id` (the enrolled students placed in its sections
that year), plus the `subjects` and the `status` for new entries (`draft` by default, or
`entered`). Students not yet entered get an entry; students already entered get the subjects they
lack (the tier and code of subjects they have are kept); withdrawn students are skipped. The
answer counts `created`, `updated`, `unchanged` and `skipped_withdrawn`.

**Candidate numbers** are typed per entry, or assigned in bulk
(`POST .../{sessionId}/candidate-numbers`: `start`, `width` to zero-pad to, `prefix`): the draft and
entered entries without one are numbered by student name, skipping numbers already used in the
session (`nextCandidateNumbers`).

**The board's list** (`GET .../{sessionId}/entries/export`) is a CSV, UTF-8 with a byte-order mark
so Excel reads Arabic names, one row per entered subject (one per entry for an exam entered as a
whole), by candidate number: candidate number, admission number, last, first and middle name, date
of birth, exam code, series, subject code and name, tier, option code, status. Drafts are left out
unless `include_drafts=true`. Every cell goes through `csvCell` (no spreadsheet formulas).

**Results**: recording or editing a result takes an optional `entry_id`: an entry of the same
student and exam, not a draft, and (when the entry lists subjects) covering the result's subject.
On edit, leaving `entry_id` out keeps the link and `null` clears it. Each entry shows how many
results were recorded from it.

## Access

| Who                                            | Sessions    | Entries of a session | A student's entries       |
| ---------------------------------------------- | ----------- | -------------------- | ------------------------- |
| School leadership (`academicConfig:manage`)    | read, write | read, write, export  | read                      |
| Teachers (`academicConfig:read`, `grade:read`) | read        | —                    | read, students they teach |
| The student; linked parents (`grade:read`)     | —           | —                    | read their own / child's  |

No permission was added. A session's entry list is the school's planning, so reading it is
leadership-only like every write. A student's entries are read by whoever may read the student
(`app.can_read_student`), enforced by the API (403, or 404 for a student outside the school) and by
the restrictive `role_scope_visibility` policy on entries and entry subjects. Students and parents
see entered and withdrawn entries (exam, series, dates, subjects with tier and code, candidate
number, status), never drafts or the school's notes. Sessions are configuration: tenant isolation
only.

`app.subjects` is role-scoped, so `app.external_exam_entry_subjects_of(student_id)` (SECURITY
DEFINER, checks `app.can_read_student` itself) names the subjects of a student's entries without
widening it, as `app.external_exam_result_subjects` does for results.

Every write is audited with old and new values (`external_exam_sessions`, `external_exam_entries`:
one row per entry created, changed, renumbered or deleted); the CSV export is audited as an
`export` of the session.

## API

| Method | Path                                                                | Permission               |
| ------ | ------------------------------------------------------------------- | ------------------------ |
| GET    | `/api/grading/external-exam-sessions?exam_id=`                      | `academicConfig:read`    |
| POST   | `/api/grading/external-exam-sessions`                               | `academicConfig:manage`  |
| PUT    | `/api/grading/external-exam-sessions/{sessionId}`                   | `academicConfig:manage`  |
| DELETE | `/api/grading/external-exam-sessions/{sessionId}`                   | `academicConfig:manage`  |
| GET    | `/api/grading/external-exam-sessions/{sessionId}/entries`           | `academicConfig:manage`  |
| POST   | `/api/grading/external-exam-sessions/{sessionId}/entries`           | `academicConfig:manage`  |
| POST   | `/api/grading/external-exam-sessions/{sessionId}/entries/status`    | `academicConfig:manage`  |
| POST   | `/api/grading/external-exam-sessions/{sessionId}/candidate-numbers` | `academicConfig:manage`  |
| GET    | `/api/grading/external-exam-sessions/{sessionId}/entries/export`    | `academicConfig:manage`  |
| PUT    | `/api/grading/external-exam-entries/{entryId}`                      | `academicConfig:manage`  |
| DELETE | `/api/grading/external-exam-entries/{entryId}`                      | `academicConfig:manage`  |
| GET    | `/api/grading/students/{studentId}/external-exam-entries`           | `grade:read` + row scope |

A session of an archived exam can still be edited and read, but takes no new session and no new
students (409).

## Privacy

Entries and entry subjects carry `student_id`, so the GDPR pipeline's catalog-driven discovery
includes them in a student's export and erasure walk with no registry change; an entry's `note` is
a personal-data column by name and is set to NULL on erasure.
