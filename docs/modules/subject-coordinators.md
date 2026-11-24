# Subject coordinators

A **subject coordinator** follows one subject across every section of the grades they cover for an
academic year ("head of maths for grades 10–12"): which mark sheets are in, how each section is
doing, and the marks behind it. Coordinating is **not a role** (roles are a fixed enum, ADR-002): it
is an assignment on top of the person's existing staff role, usually `INSTRUCTOR`.

- Migration: `db/migrations/000260_subject_coordinators.sql`
- API: `apps/api/src/modules/grading/coordinator-service.ts`, `routes/coordinator-routes.ts`; the
  shared helpers are in `apps/api/src/modules/grading/access.ts`
- Web: Academic setup > Coordinators (`apps/web/src/features/principal/academic-setup/CoordinatorsTab.tsx`)
- Mobile: teacher Classes tab > Coordinator (`coordinator_subjects_screen.dart`,
  `coordinator_mark_sheet_screen.dart`)
- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-H

## Data

| Table                                  | Holds                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `app.subject_coordinators`             | school, academic year, subject, user; unique per (school, year, subject, user)              |
| `app.subject_coordinator_grade_levels` | the grade levels an assignment is limited to; **none means every grade taught the subject** |

"Every grade taught the subject" means every grade level (and section) of the year that has a
subject configuration for it, so a physics coordinator never reaches grade 1. Both tables are
configuration, like teacher assignments: tenant isolation only, so a teacher's app can show who
coordinates a subject. Deleting an assignment deletes its grade levels.

The coordinator must be a member of the school's staff (`SCHOOL_STAFF_ROLES`); a student or parent
is refused with `VALIDATION_FAILED`. A repeat (same year, subject and person) is
`409 SUBJECT_COORDINATOR_DUPLICATE`.

## What a coordinator reads

For their subjects, in the sections of the grades they cover, **read-only**:

| Data                                | How                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Raw marks                           | `app.can_read_student_mark` accepts `app.coordinates_section_subject` beside the teacher check          |
| Mark sheets and assessment releases | already tenant-wide configuration                                                                       |
| Predicted grades                    | `app.student_predicted_grades` policy: `... OR app.coordinates_student_subject(...)`                    |
| Finalized subject results           | `app.student_subject_results` policy: `... OR app.coordinates_result_subject(...)`                      |
| The students and their placements   | `app.students` / `app.student_sections` policies: `app.coordinates_student` / `app.coordinates_section` |
| Elective choices for the subject    | `app.student_subject_enrollments` policy: `app.coordinates_student_subject`                             |
| The subject's name                  | `app.can_read_subject` gains a coordinator arm                                                          |

Overall results, certificates, report notes, attendance and everything else about a student stay
as they were: a coordinator is not the students' teacher. A coordinator of another subject sees
none of this subject's rows. Every `CREATE OR REPLACE` in 000260 keeps the function's latest body
(000173 for `can_read_student_mark`, 000254 for `can_read_subject`) and only adds a check.

Writing stays where it was: entering marks, adding assessments, submitting and releasing use
`assertCanGradeSectionSubject` (teachers and leadership); approving and finalizing stay with
leadership.

## Helpers (for later workstreams)

SQL, all `SECURITY DEFINER`, current school and current user:

| Function                                                          | True when the current user…                                                       |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `app.coordinates_subject(subject_id uuid, academic_year_id uuid)` | coordinates the subject that year, for any grade                                  |
| `app.coordinates_section_subject(section_id, subject_id)`         | coordinates the subject for that section's year and grade, and it is taught there |
| `app.coordinates_section(section_id)`                             | coordinates any subject taught in the section                                     |
| `app.coordinates_student_subject(student_id, subject_id, year)`   | coordinates the subject for the student's section that year                       |
| `app.coordinates_student(student_id)`                             | coordinates a subject in a section the student is placed in                       |
| `app.coordinates_result_subject(finalization_id, subject_id)`     | coordinates the subject for the finalized section                                 |

TypeScript (`apps/api/src/modules/grading/access.ts`, re-exported from `modules/grading`):

```ts
coordinatesSubject(tx, subjectId, academicYearId, sectionId?): Promise<boolean>
assertCoordinatesSubject(tx, subjectId, academicYearId, sectionId?): Promise<{ leadership: boolean }>
  // leadership passes; otherwise the coordinator (for the section's grade when sectionId is given);
  // else 403 AUTHZ_FORBIDDEN
coordinatedSubjects(tx, userId, academicYearId): Promise<CoordinatedSubject[]>
  // { coordinator_id, subject_id, subject_code, subject_name, grade_level_ids } by subject name;
  // grade_level_ids [] = every grade
assertCanReadSectionSubject(tx, sectionId, subjectId): Promise<{ access: "leadership" | "teacher" | "coordinator" }>
```

## API

| Operation                   | Route                                                                    | Permission              |
| --------------------------- | ------------------------------------------------------------------------ | ----------------------- |
| `listSubjectCoordinators`   | `GET /api/grading/years/{yearId}/subject-coordinators`                   | `academicConfig:read`   |
| `createSubjectCoordinator`  | `POST /api/grading/years/{yearId}/subject-coordinators`                  | `academicConfig:manage` |
| `updateSubjectCoordinator`  | `PATCH /api/grading/subject-coordinators/{coordinatorId}` (grade levels) | `academicConfig:manage` |
| `deleteSubjectCoordinator`  | `DELETE /api/grading/subject-coordinators/{coordinatorId}`               | `academicConfig:manage` |
| `listMyCoordinatedSubjects` | `GET /api/grading/my-coordinated-subjects?academic_year_id=`             | `academicConfig:read`   |

Every write is audited (`subject_coordinators`). `listMyCoordinatedSubjects` returns the caller's
own subjects for the year (default: the latest active or finalized year), each with its sections:
teachers assigned, students taking it, each period's mark sheet status, the current average from
the marks recorded so far (the engine's preview, provisional where incomplete) and the averages of
the subject's finalized results.

The coordinator opens a section with the existing `getMarkSheet` and `getSectionPredictedGrades`:
`MarkSheet.access` is `coordinator` with `can_edit_marks` and `can_add_assessments` false, and
`SectionPredictedGrades.editable` is false. Their writes answer 403.

## Web

Academic setup > Coordinators, for the selected year: the list (subject, person, grades) and, for
leadership with `academicConfig:manage`, add (subject, teacher, grades), change grades and remove.

## Mobile

On the teacher's Classes tab, under Marks, a **Coordinator** entry appears only when the teacher
coordinates a subject that year. It opens the subjects with their sections (teachers, students,
sheet status per period, current and final averages); a section opens its marks read-only, period by
period. An unknown sheet status reads as "Locked"; an unknown `access` is treated as read-only; a
missing one (an older server) as a teacher.
