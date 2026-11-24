# Lesson and term plans + learning outcomes

Two related features for schools that plan against a curriculum's outcomes (Jordan and the wider
Arab region ask for both):

- **Learning outcomes**: a catalogue per subject and grade level, and each student's achievement
  per outcome and period on the school's scale, optionally shown on report cards.
- **Plans**: a term plan per section and subject (weeks, units, outcomes, notes) and daily lesson
  plans, written by teachers and reviewed by the subject's coordinator or leadership.

Everything is opt-in: a school that adds no outcomes and writes no plans sees nothing new, and
report cards only change once leadership switches outcome achievement on.

- Migration: `db/migrations/000268_lesson_plans_and_learning_outcomes.sql`
- API: `apps/api/src/modules/academic-planning/` (`settings-service.ts`, `outcome-service.ts`,
  `plan-service.ts`, `report-snapshot.ts`, `outcome-routes.ts`, `plan-routes.ts`); finalization
  calls `snapshotOutcomeAchievements` from `grading/results-service.ts`
- Web (leadership): Academic setup > Learning outcomes (`LearningOutcomesTab.tsx`) and > Lesson
  plans (`PlansTab.tsx`); report cards print outcomes (`CertificateView.tsx`)
- Mobile (teachers): class > Lesson plans (`academic_plans_screen.dart`,
  `term_plan_editor_screen.dart`, `lesson_plan_editor_screen.dart`) and class > Learning outcomes
  (`outcome_achievement_screen.dart`); coordinators: Classes tab > Plans to review
  (`plan_reviews_screen.dart`); students and parents: report card section of the results screens
- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-O

## Data

| Table                                            | Holds                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.academic_planning_settings`                 | per school: `show_outcomes_on_report_cards` (false), `lesson_plan_lead_days` (1), `term_plan_due_days` (7)                                         |
| `app.outcome_achievement_levels`                 | the scale, level 1..n (lowest first), English and Arabic labels; **no rows: the default four**                                                     |
| `app.learning_outcomes`                          | subject, grade level, code (unique per subject and grade), text, `text_ar`, strand, order, archived                                                |
| `app.student_outcome_achievements`               | section, period (term, or the year when `term_id` is null), student, outcome, level, who entered it                                                |
| `app.finalized_outcome_achievements`             | append-only snapshot per finalization: code, text, strand and level labels as finalized                                                            |
| `app.term_plans` (+ `_weeks`, `_week_outcomes`)  | one per section, subject and term; weeks with unit, notes and outcomes                                                                             |
| `app.lesson_plans` (+ `_outcomes`, `_materials`) | date, optional timetable period, title, objectives, activities, resources, homework, reflection; linked class materials keep their title as linked |

The default scale is Beginning / Developing / Meeting / Exceeding (مبتدئ / في طور النمو / متحقق /
متجاوز للتوقعات). Replacing the scale renumbers it 1..n; a level some student already holds cannot
be dropped (409 `CONFLICT_STATE_MISMATCH`). An outcome used by achievement or a plan can be
archived but not deleted (409 `LEARNING_OUTCOME_IN_USE`); archived outcomes leave the pickers but
still show where they were used. A repeated code is 409 `LEARNING_OUTCOME_DUPLICATE`.

## Who sees and does what

| Who                                            | Outcomes                                                     | Plans                                                       |
| ---------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| Leadership (`academicConfig:manage`)           | catalogue, CSV import, scale, settings                       | reads all, approves / returns, coverage view (web)          |
| Teacher of the section and subject             | records achievement (`grade:update`)                         | writes, submits, deletes drafts, reflection (`lesson:*`)    |
| The subject's coordinator (000261)             | reads the section's achievement, read-only                   | reads, approves / returns (app), coverage of their subjects |
| Another teacher, another subject's coordinator | nothing (403 / empty)                                        | nothing (404)                                               |
| Student / parent                               | finalized achievement on report cards only, when switched on | nothing                                                     |

RLS: plans, their parts and draft achievement are visible through
`app.can_read_section_subject_work(section_id, subject_id)` (leadership, `teaches_section_subject`,
`coordinates_section_subject`); the snapshot follows finalized results
(`app.can_read_student_result`, plus `app.coordinates_result_subject`). Settings, the scale and the
catalogue are configuration (tenant isolation only). 000268 changes no existing function or policy.

A reviewer is never the plan's author. Plan reads and reviews are gated on `academicConfig:read`
(coordinators hold no approval permission) and narrowed by the service.

## Plan workflow

`draft` → `submitted` → `approved` | `returned` (a comment is required). A returned plan is edited
and submitted again; an approved plan is final except the lesson's reflection, which the teacher
writes after teaching (`PUT /api/grading/lesson-plans/{planId}/reflection`, any status). Only a
draft can be deleted. Every write and every review is audited with the old and new status.

**On time** is measured from the first submission, in the school's timezone: a term plan by the
term's first day plus `term_plan_due_days`; a lesson plan `lesson_plan_lead_days` before the lesson.
Resubmitting a returned plan does not change it.

**Coverage** (`GET /api/grading/plan-coverage?term_id=`) lists every section and subject with an
assigned teacher (or a plan) for the term: the term plan's status and timeliness, lesson plans by
status, on time, late and overdue (still a draft past its due day), and how many of the grade's
active outcomes the term's submitted (non-draft) plans name.

## Report cards (ADR-017)

When `show_outcomes_on_report_cards` is on, finalizing a section's period (and each correction)
copies that period's achievement into `app.finalized_outcome_achievements`. Finalized results
(`FinalizedSubjectResult.outcomes`) and report card / certificate content (`subjects[].outcomes`,
additive and absent on older documents) read the snapshot only. Achievement for a finalized period
is locked (409 `RESULTS_ALREADY_FINALIZED`).

## API

| Operation                                                        | Route                                                                                     | Permission                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `getPlanningSettings`                                            | `GET /api/grading/planning-settings`                                                      | `academicConfig:read`                                     |
| `updatePlanningSettings`                                         | `PUT /api/grading/planning-settings`                                                      | `academicConfig:manage`                                   |
| `listLearningOutcomes`                                           | `GET /api/grading/learning-outcomes?subject_id&grade_level_id&include_archived`           | `academicConfig:read`                                     |
| `createLearningOutcome`                                          | `POST /api/grading/learning-outcomes`                                                     | `academicConfig:manage`                                   |
| `updateLearningOutcome`                                          | `PATCH /api/grading/learning-outcomes/{outcomeId}` (incl. `archived`)                     | `academicConfig:manage`                                   |
| `deleteLearningOutcome`                                          | `DELETE /api/grading/learning-outcomes/{outcomeId}`                                       | `academicConfig:manage`                                   |
| `importLearningOutcomes`                                         | `POST /api/grading/learning-outcomes/import` (`csv`, `dry_run`)                           | `academicConfig:manage`                                   |
| `getSectionOutcomeAchievements`                                  | `GET /api/grading/sections/{sectionId}/subjects/{subjectId}/outcome-achievements?term_id` | `grade:read`                                              |
| `saveSectionOutcomeAchievements`                                 | `PUT` same path                                                                           | `grade:update`                                            |
| `listTermPlans` / `createTermPlan`                               | `GET` / `POST .../sections/{sectionId}/subjects/{subjectId}/term-plans`                   | `academicConfig:read` / `lesson:create`                   |
| `getTermPlan` / `updateTermPlan` / `deleteTermPlan`              | `GET` / `PUT` / `DELETE /api/grading/term-plans/{planId}`                                 | `academicConfig:read` / `lesson:update` / `lesson:delete` |
| `submitTermPlan` / `reviewTermPlan`                              | `POST /api/grading/term-plans/{planId}/submit` / `/review`                                | `lesson:update` / `academicConfig:read`                   |
| `listLessonPlans` / `createLessonPlan`                           | `GET` / `POST .../lesson-plans` (`from`, `to`)                                            | `academicConfig:read` / `lesson:create`                   |
| `getLessonPlanOptions`                                           | `GET .../lesson-plan-options?date` (timetable periods, materials, outcomes)               | `academicConfig:read`                                     |
| `getLessonPlan` / `updateLessonPlan` / `deleteLessonPlan`        | `GET` / `PUT` / `DELETE /api/grading/lesson-plans/{planId}`                               | as for term plans                                         |
| `submitLessonPlan` / `reviewLessonPlan` / `saveLessonReflection` | `POST .../submit`, `POST .../review`, `PUT .../reflection`                                | `lesson:update` / `academicConfig:read` / `lesson:update` |
| `listPlanReviews`                                                | `GET /api/grading/plan-reviews?academic_year_id&status` (default `submitted`)             | `academicConfig:read`                                     |
| `getPlanCoverage`                                                | `GET /api/grading/plan-coverage?term_id`                                                  | `academicConfig:read`                                     |

**CSV import** columns (header row, case-insensitive; comma, semicolon or tab): `subject` (subject
code), `grade` (grade level name), `code`, `text`, and optionally `text_ar`, `strand`, `sort_order`.
A row whose subject, grade and code exist updates that outcome; without `sort_order` an existing
outcome keeps its place and a new one goes last. All or nothing: any row error writes nothing and
every error comes back with its line. At most 2000 rows.

Lesson plan periods come from the term's live (approved) timetable: the class of the section whose
course is the subject, on the date's ISO weekday. Materials must be uploaded to that class.

## Mobile

Unknown statuses read as "Unknown" and are never editable; a missing `editable` / `can_*` flag (an
older server) reads as read-only; results without `outcomes` show no outcomes section.
