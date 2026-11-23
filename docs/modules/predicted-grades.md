# Predicted grades

IGCSE, A-Level and IB schools send each student's **predicted grades** to universities and use them
for exam entries: the subject teacher's forecast of the grade the student will reach. Studafy keeps
one current prediction per student, subject and period (a term, or the whole year), opt-in per grade
and year.

- Migration: `db/migrations/000254_predicted_grades.sql`
- API: `apps/api/src/modules/grading/predicted-grades-service.ts`,
  `routes/predicted-grades-routes.ts` (tag "Results")
- Web: Academic setup > Subjects (the grade's policies) and the principal's student page
  (`apps/web/src/features/principal/students/predicted-grades`)
- Mobile: teacher class detail > Predicted grades (`predicted_grades_screen.dart`); the student's
  and parent's results screen (`predicted_grades_section.dart`)
- Plan: [`docs/plans/curriculum-support.md`](../plans/curriculum-support.md), WS-C

## Settings

Two columns on `app.grade_programs` (a grade in one academic year), saved with the grade's other
policies (`PUT /api/grading/years/{yearId}/programs/{gradeLevelId}`):

| Column                        | Default | Meaning                                                    |
| ----------------------------- | ------- | ---------------------------------------------------------- |
| `predicted_grades_enabled`    | `false` | Teachers record predicted grades for this grade this year. |
| `predicted_grades_visibility` | `staff` | `staff`, or `students_and_parents` as well.                |

Nothing changes for a school that never switches them on. Copying a year's configuration copies both.

## Data

`app.student_predicted_grades`: school, academic year, optional term (`NULL` = the whole year),
student, subject, `grade_label` (at most 40 characters), optional `note` (at most 1000), who entered
it last, timestamps. Partial unique indexes keep one row per (school, year, term, student, subject)
and one per (school, year, student, subject) for the year, as `app.mark_sheets` does. The table
holds the current value only; every change is in `app.audit_logs`.

Predictions are not results. Finalization, report cards, certificates and transcripts never read
them, so finalized snapshots (ADR-017) are unaffected.

## Rules

- Only an **enabled** program accepts predictions (`409 PREDICTED_GRADES_DISABLED` otherwise), and
  only while the year is neither finalized nor archived (`409 ACADEMIC_CONFIG_LOCKED`).
- The label must be one of the bands of the subject's **grade scale** (the subject's own scale, else
  the grade's) when there is one (`400 VALIDATION_FAILED`); without a scale any short label is
  accepted. Labels are trimmed; a blank or null label removes the prediction.
- Students must take the subject in the section (its roster, exempt students excluded).
- A note left out of a save keeps the saved note.

## Access

| Who                                     | Reads                                                                                                 | Writes |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ |
| School leadership (admin, principal)    | every prediction, with notes                                                                          | yes    |
| Teacher of the subject in the section   | that section and subject; the student route for students they teach                                   | yes    |
| Other teachers of the student's section | the student route (with notes)                                                                        | no     |
| The student and linked parents          | their own, only while the year's program is enabled and set to `students_and_parents`; never the note | no     |

Route permissions: reads need `grade:read`; writes need `grade:update` (teachers) or
`result:finalize` (principals, who do not hold `grade:update`), the same pair as report card notes.
The row check is `app.teaches_section_subject` or school leadership. No new permission was added.

The database enforces the read side on its own: a restrictive `role_scope_visibility` policy calls
`app.can_read_student_predicted_grade(student_id, academic_year_id)` (leadership; a teacher of the
student's section that year, `app.teaches_in_section`; or the student or a linked parent while the
program shows them). `app.can_read_subject` gains a matching arm so a visible prediction comes back
with its subject's name, as released marks do (000173, 000229).

## API

| Route                                                                         | Purpose                                                                                                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/predicted-grades` | The roster with each prediction for `term_id` (or the year), the scale's labels, the year's terms, `enabled` and `editable`.      |
| `PUT` the same path                                                           | Bulk save `{ term_id, grades: [{ student_id, grade_label, note? }] }` (1 to 500), audited with old and new values.                |
| `GET /api/grading/students/{studentId}/predicted-grades`                      | By year (newest first): section, settings, `can_edit`, and for leadership the subjects (with labels) and terms it may predict in. |

Leadership edits one student's prediction from the web through the section route with a single item.

## Clients

- **Web**: the program form has "Teachers record predicted grades" and "Predicted grades are seen
  by". The principal's student page shows a "Predicted grades" card per year, with add, edit and
  remove while `can_edit`; it is hidden when the student has no year with predicted grades.
- **Mobile, teacher**: "Predicted grades" on the class detail resolves the class to its section and
  subject (`GET /api/academics/classes/{id}`, then its course), then shows one dropdown per student
  from the scale's labels (or a text field without a scale), by period. Read-only, with the reason,
  when the grade has them switched off or the year is closed.
- **Mobile, student and parent**: a read-only "Predicted grades" block on the results screen, shown
  only when a year has visible predictions. Parsing is defensive: unknown fields or shapes are
  skipped, so older app builds keep working.
