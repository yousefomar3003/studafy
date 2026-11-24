# Remedial plans

A **remedial plan** helps a struggling student catch up in one subject, for a term or the whole
year: why it was opened, the skills or outcomes it targets, what the teacher and student will do,
when it is reviewed, and a timeline of progress and follow-up notes. Teachers write plans in the
mobile app; the subject's coordinator follows them up in the app; school leadership follows them up
on the web; the student and parents read a plan in the app only when the school shares it.

- Migration: `db/migrations/000268_remedial_plans.sql`
- API: `apps/api/src/modules/remedial-plans/` (`service.ts`, `routes.ts`, `schemas.ts`)
- Web: Academic setup > Remedial plans (`apps/web/src/features/principal/academic-setup/RemedialPlansTab.tsx`)
- Mobile: `apps/mobile/lib/src/features/remedial_plans/` (teacher class detail > Remedial plans;
  Coordinator > a section > Remedial plans; results screen > Support plans)
- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-P

## Data

| Table                            | Holds                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `app.remedial_plans`             | year, optional term (none = the whole year), section, student, subject, reason, targets, actions, status |
| `app.remedial_plan_reviews`      | the plan's review dates, each done (`completed_at`) or not                                               |
| `app.remedial_plan_notes`        | the timeline, append-only: notes (`internal` = staff only) and status changes, with the author's access  |
| `app.remedial_plan_outcomes`     | **extension point, empty**: the learning outcomes a plan targets, for WS-O (000267)                      |
| `app.school_settings` (+ column) | `remedial_plans_family_visible`: whether plans may be shared with families (default off)                 |

- **Reason**: `below_pass` (current marks below the subject's pass percentage) or `teacher_concern`.
  The student's percentage and the pass percentage when the plan was opened are kept with it
  (`start_percentage`, `pass_percentage`).
- **Status**: `open` → `in_progress` → `achieved` / `closed`, forward only (`open` may also go
  straight to `achieved` or `closed`). Each change is a `status_change` entry on the timeline. An
  achieved or closed plan is history: edits answer `409 REMEDIAL_PLAN_CLOSED`; notes are still
  accepted.
- **One active plan** (open or in progress) per student, subject and period: a second is
  `409 REMEDIAL_PLAN_DUPLICATE`. A term plan and a whole-year plan are different periods.
- **Section**: the plan belongs to the section the student was placed in when it was opened; that
  section's teachers of the subject write it.
- **Reviews**: a review is done once someone following the plan adds a note on or after its date
  (school time, `app.school_today()`). An active plan with an earlier review not done is
  **overdue**. Editing the review dates keeps whether the dates kept were done.
- **Targets** are free text. WS-O links outcomes by writing `app.remedial_plan_outcomes`
  (`outcome_id`, adding the foreign key to its catalogue); the API does not write it yet.
- Plans are never deleted (close one instead). Remedial plans are not results: finalization, report
  cards, certificates and transcripts never read them.

## Who sees and does what

| Who                                  | Reads                                                                                        | Writes                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| School leadership                    | every plan, every note                                                                       | opens, edits, moves status, adds notes |
| The section's teacher of the subject | that section-subject's plans, every note                                                     | opens, edits, moves status, adds notes |
| The subject's coordinator (000260)   | the plans of the sections and grades they coordinate                                         | adds notes (follow-up), never edits    |
| Another teacher                      | nothing                                                                                      | nothing                                |
| The student and linked parents       | a plan only while the school allows sharing **and** the plan is shared; never internal notes | nothing                                |

The database enforces this (`app.can_read_remedial_plan`, `app.can_read_remedial_plan_entry`, the
restrictive insert/update policies built on `app.remedial_plan_staff_access`); the API checks writers
with the grading module's helpers (`assertCanGradeSectionSubject`, `assertCanReadSectionSubject`)
before writing. A family may not otherwise see the subject's name, so it reaches them through
`app.remedial_plan_subject_name(plan_id)`, which answers only for a plan they may read
(`app.can_read_subject` is unchanged). Turning the school's sharing off hides every plan from
families at once; each plan keeps its own choice.

## Suggestions

`getSectionRemedialPlans` lists the students taking the subject in the section whose current
percentage for the period (term, or the year) is below the subject's pass percentage: the rounded
result when every mark is in, otherwise the grading engine's preview from the marks recorded so far
(`provisional: true`). It loads the section's configuration, roster and marks once
(`loadSectionsGradingData`), never per student. A descriptive subject has no pass percentage and no
suggestions. A suggestion carries `active_plan_id` when the student already has a plan for the
period.

## API (tag "Remedial plans")

| Operation                    | Route                                                                              | Permission                          |
| ---------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| `listRemedialPlans`          | `GET /api/grading/remedial-plans` (year, grade, section, subject, status, overdue) | `grade:read`                        |
| `createRemedialPlan`         | `POST /api/grading/remedial-plans`                                                 | `grade:update` or `result:finalize` |
| `getRemedialPlan`            | `GET /api/grading/remedial-plans/{planId}`                                         | `grade:read`                        |
| `updateRemedialPlan`         | `PATCH /api/grading/remedial-plans/{planId}`                                       | `grade:update` or `result:finalize` |
| `addRemedialPlanNote`        | `POST /api/grading/remedial-plans/{planId}/notes`                                  | `grade:update` or `result:finalize` |
| `getSectionRemedialPlans`    | `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/remedial-plans`        | `grade:read`                        |
| `getStudentRemedialPlans`    | `GET /api/grading/students/{studentId}/remedial-plans`                             | `grade:read`                        |
| `getRemedialPlanSettings`    | `GET /api/grading/remedial-plan-settings`                                          | `academicConfig:read`               |
| `updateRemedialPlanSettings` | `PUT /api/grading/remedial-plan-settings`                                          | `academicConfig:manage`             |

The permission only lets a role call the route; the rows are the database's. The list is a staff
list (a student or parent gets an empty one) of at most 500 plans (`truncated`), with counts per
status and overdue over the whole year. Each plan carries `access` (`leadership`, `teacher`,
`coordinator`, `family`), `can_edit` and `can_add_note`. Every write is audited (`remedial_plans`,
`remedial_plan_notes`, `school_settings`). Plans open while the year's grading is draft or active
(`409 ACADEMIC_CONFIG_LOCKED` once finalized or archived).

## Web

Academic setup > Remedial plans (leadership: `academicConfig:manage` or `result:finalize`): the
sharing setting (editable with `academicConfig:manage`), counts per status and overdue reviews, the
plans filtered by grade, subject, status or overdue review, and a plan's details, reviews and
timeline with a follow-up note form. Also in global search.

## Mobile

- **Teacher**: class detail > Remedial plans: pick the period, see the suggested students (their
  current mark), open a plan for one (or any student), and the year's plans; a plan opens its
  details, reviews and timeline, with edit (reason, targets, actions, review dates, sharing, status)
  and add note (optionally staff only).
- **Coordinator**: Coordinator > a section's "Remedial plans": the same screen without opening or
  editing; they add follow-up notes.
- **Student and parent**: the results screen's "Support plans" block lists the shared plans (it takes
  no space otherwise), each opening read-only.

An unknown status reads as "Updated", an unknown reason as the teacher's concern, an unknown access
as read-only; a missing field degrades to empty.
