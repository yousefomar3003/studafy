# Graduation requirements

A school sets out what a student needs to graduate — an American diploma's credits, credits in
English or the sciences, required subjects, a minimum cumulative GPA or average, a national or
admissions exam (Tawjihi, SAT) — and Studafy checks every student against it from their finalized
results. Leadership sees each student's checklist and the students of a grade who are not on track;
students and parents see their own checklist in the app when the school chooses; transcripts say
whether the requirements were met.

- Plan: [`docs/plans/curriculum-support.md`](../plans/curriculum-support.md), WS-F
- Migration: `db/migrations/000258_create_graduation_requirements.sql`
- Rules: `packages/grading-engine/src/graduation.ts` (`evaluateGraduationRequirements`,
  `validateGraduationRule`)
- API: `apps/api/src/modules/graduation-requirements` (tag "Graduation requirements")
- Web: Academic setup › Graduation requirements (`GraduationRequirementsTab.tsx`: sets, a check
  against a student, the not-on-track report); the student page's "Graduation requirements" panel
  (`GraduationPanel.tsx`); the transcript's "Graduation requirements" line
  (`TranscriptGraduation.tsx`)
- Mobile: "Graduation requirements" on the results screen, for the student and for a parent's child,
  when the school shows the set (`features/student/presentation/widgets/graduation_requirements_section.dart`);
  the transcript screen's line

The feature is opt-in: a school that adds no set sees an empty tab, an empty panel, nothing in the
apps, and its transcripts are unchanged.

## Data model

| Table                                         | One row per                                           |
| --------------------------------------------- | ----------------------------------------------------- |
| `app.graduation_requirement_sets`             | requirement set: name, from which year, active, shown |
| `app.graduation_requirement_set_grade_levels` | grade level a set applies to                          |
| `app.graduation_requirements`                 | rule of a set: type, minimum, group name, exam, order |
| `app.graduation_requirement_subjects`         | subject in a rule's named group                       |

- **Set**: `name` (unique per school, case-insensitively), `applies_from_academic_year_id` (applies
  to students in that year or a later one; null: every year), `is_active`,
  `visible_to_students_and_parents` (default off).
- **Rule**: `rule_type`, `min_value numeric(8,2)`, `group_name`, `external_exam_id`, `sort_order`. A
  CHECK per type keeps the columns consistent (below). Subjects have no group of their own, so a
  rule names its group (`group_name`, "English") and lists its subjects in
  `app.graduation_requirement_subjects`.
- Grade levels and subjects are child tables with composite foreign keys rather than `uuid[]`
  columns, so a referenced grade level, subject or exam cannot disappear from under a rule (they are
  `ON DELETE RESTRICT`; a set's grade levels, rules and subjects are deleted with it).

| `rule_type`          | Met when                                                          | `min_value`   | Group | Exam |
| -------------------- | ----------------------------------------------------------------- | ------------- | ----- | ---- |
| `total_credits`      | credits earned ≥ `min_value`                                      | 0 < N ≤ 1000  | —     | —    |
| `group_credits`      | credits earned in the group's subjects ≥ `min_value`              | 0 < N ≤ 1000  | yes   | —    |
| `subjects_passed`    | every subject of the group passed (in any year)                   | none          | yes   | —    |
| `cumulative_gpa`     | the transcript's cumulative GPA ≥ `min_value`                     | 0 < X ≤ 10    | —     | —    |
| `cumulative_average` | the transcript's cumulative average (%) ≥ `min_value`             | 0 < X ≤ 100   | —     | —    |
| `external_exam`      | a result recorded for the exam, with a total ≥ `min_value` if set | optional, > 0 | —     | yes  |

## Rules

A student is checked on read — nothing is stored per student — by
`evaluateGraduationRequirements`, against:

- the rows an academic transcript reads: each academic year's **current, finalized annual** result
  (a superseded finalization or a term result never counts; two in one year keep the later), with
  each subject's coefficient and the latest year's rounding from the snapshots;
- the student's recorded external exam results (WS-D, `docs/modules/external-exams.md`).

Credits use the same rule as results and transcripts
([`academic-grading.md`](../database/academic-grading.md), "Credits"): a complete, non-exempt subject
that carries credits counts, whether or not it is in the average, and earns its credits when passed —
a pass/fail (descriptive) subject included. The cumulative GPA and average are exactly the
transcript's (`calculateCumulativeResult`); a GPA that cannot be worked out (missing points, mixed
scales) does not meet a GPA rule. An exam rule takes the student's best total; a result without a
total meets only a rule with no minimum. A subject failed one year and passed later counts as passed.

Each rule is:

- **met** when the finalized results already satisfy it;
- **pending** ("In progress") when they do not yet but the student's current year is not finalized
  — the year of their latest placement is still planned or active and has no finalized annual
  result — so results still to come can change the answer. A cumulative GPA or average rule stays
  pending until that year is finalized even when it is above the minimum, because the year can
  still lower it; credits and passes are never taken away, so reaching them is met at once;
- **not met** otherwise.

Each evaluated rule carries `current` (credits earned, subjects passed, the GPA, the average or the
best exam total) and `required`, so a gap reads "2 of 4 English credits"; a subjects rule also names
the subjects not passed yet. A set is met when every rule is met, not met when any is not met, and
pending otherwise (a set without rules is met).

**Which sets apply.** An active set applies to a student when it lists the grade level of the
student's latest placement (`app.student_sections`; without one, the grade of their latest
finalized year) and, when it applies from a year, that placement's year starts on or after it.
Several sets can apply (a standard and an honours diploma); each is checked separately.

## Access

| Who                                            | Sets                       | A student's checklist                          | Report |
| ---------------------------------------------- | -------------------------- | ---------------------------------------------- | ------ |
| School leadership (ORG_ADMIN, PRINCIPAL)       | read, create, edit, delete | read (every set), preview any set              | read   |
| Teachers (`academicConfig:read`, `grade:read`) | read                       | read (every set), for students they teach      | —      |
| The student; linked parents (`grade:read`)     | —                          | their own / their child's, **shown sets only** | —      |

No permission was added: managing, previews and the report use `academicConfig:manage`, reading the
sets `academicConfig:read`, a checklist `grade:read` with the row scope `app.can_read_student`
(403, or 404 for a student outside the school), the same checks as the external exams module. A
caller who is the student or a linked parent — and not staff over the student — sees only sets with
`visible_to_students_and_parents`. The tables are configuration, so they have tenant isolation only;
the results and exam rows read keep their own role-scoped policies.

`app.subjects` is role-scoped, so a student may not see a required subject they have not taken.
`app.graduation_requirement_subject_names(set_ids)` (SECURITY DEFINER) returns the code and name of
the subjects rules name, only for sets shown to students and parents or for staff, without widening
`app.subjects`.

Every write is audited (`graduation_requirement_sets`) with the old and new set, rules included.

## API

| Method | Path                                                                            | Permission               |
| ------ | ------------------------------------------------------------------------------- | ------------------------ |
| GET    | `/api/grading/graduation-requirement-sets`                                      | `academicConfig:read`    |
| POST   | `/api/grading/graduation-requirement-sets`                                      | `academicConfig:manage`  |
| PUT    | `/api/grading/graduation-requirement-sets/{setId}`                              | `academicConfig:manage`  |
| DELETE | `/api/grading/graduation-requirement-sets/{setId}`                              | `academicConfig:manage`  |
| GET    | `/api/grading/graduation-requirement-sets/{setId}/preview?student_id=`          | `academicConfig:manage`  |
| GET    | `/api/grading/graduation-requirements/report?academic_year_id=&grade_level_id=` | `academicConfig:manage`  |
| GET    | `/api/grading/students/{studentId}/graduation-requirements`                     | `grade:read` + row scope |

A set is saved whole: `PUT` replaces its grade levels and rules (in order). Each rule is checked by
`validateGraduationRule` (400 with the messages); a grade level, subject, exam or year from another
school is unknown (400); a duplicate name is 409 `CONFLICT_DUPLICATE_ENTRY`.

The **preview** checks a saved set against any student of the school whether or not it applies
(`applies` says), for setting a set up. The **report** lists the students placed in the grade level
in the year (the year's placement decides grade and pending) with at least one applying set not met
(`not_met`) or not met yet (`pending`), not met first; `students_checked` counts those with any
applying set. The web shows the not-met students and, on request, the in-progress ones.

## Transcripts

When a transcript is issued (or reissued), every set that applies to the student is checked and
stored in a top-level `graduation_requirements` array of its `content`: `name`, `status` (`met`,
`not_met`, `pending`), `rules_met`, `rules_total` — "Graduation requirements met". The field is
omitted when no set applies, so transcripts of schools not using the feature, and documents issued
before it, render unchanged. Later changes to the sets or results never reach an issued transcript;
deleting a set leaves issued transcripts as they are.

## Privacy

The four tables hold configuration, not personal data, and have no `student_id`: the GDPR pipeline's
catalog-driven discovery (`apps/workers/src/queues/maintenance/tenant-tables.ts`) redacts nothing
personal in them, and no registry change was needed. A student's checklist is computed from their
result and exam rows on read and never stored, except as part of an issued transcript.
