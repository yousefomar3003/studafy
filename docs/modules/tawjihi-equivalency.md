# Tawjihi equivalency and multi-year results

Schools in Jordan that teach a foreign curriculum (IGCSE / A Level, the IB Diploma, an American
diploma) are asked what Tawjihi percentage a student's record is "worth". Studafy lets a school keep
its own conversion rules and shows each student's **estimate** with every step. Schools that report
a result across several years (Jordan's two-year Tawjihi, grade 11 + grade 12) get a weighted
multi-year result per subject and overall.

> **An estimate, not an official conversion.** The Ministry of Education sets and changes the
> equivalency rules. Every rule here is the school's own editable setting, the built-in examples
> are placeholders, and every figure is labelled as an estimate the school confirms — in the web,
> the app and the API descriptions. Nothing here claims to be the Ministry's formula.

- Plan: [`docs/plans/academic-phase2.md`](../plans/academic-phase2.md), WS-N
- Migration: `db/migrations/000266_create_equivalency_and_multi_year.sql`
- Rules: `packages/grading-engine/src/equivalency.ts` (`estimateTawjihiEquivalency`,
  `validateEquivalencyParts`, `EQUIVALENCY_EXAMPLES`) and `multi-year.ts`
  (`calculateMultiYearResult`, `validateMultiYearYears`)
- API: `apps/api/src/modules/academic-equivalency` (tags "Tawjihi equivalency", "Multi-year
  results")
- Web: Academic setup › Tawjihi equivalency (`EquivalencyTab.tsx`: rule sets, examples, a grade's
  estimates with CSV) and › Multi-year results (`MultiYearTab.tsx`); the student page's panels
  (`students/EquivalencyPanels.tsx`)
- Mobile: the results screen, for the student and for a parent's child, when the school shows them
  (`features/student/presentation/widgets/equivalency_section.dart`, `multi_year_section.dart`)

Both are opt-in: a school that adds no rule set or configuration sees empty tabs and panels and
nothing in the apps.

## Data model

| Table                                   | One row per                                                    |
| --------------------------------------- | -------------------------------------------------------------- |
| `app.equivalency_rule_sets`             | rule set: name, source system, weighted parts, active, shown   |
| `app.equivalency_rule_set_grade_levels` | grade level a set applies to                                   |
| `app.multi_year_result_configs`         | multi-year result: name, active, shown                         |
| `app.multi_year_result_config_years`    | grade level of a multi-year result, its relative weight, order |

- **Rule set**: `name` (unique per school, case-insensitively), `source_system` (`igcse_a_level`,
  `ib`, `american`, `other`: a label for lists and examples, not a constraint), `parts` (1–6, jsonb
  validated whole by the grading engine, approved in `db/policies/rls-coverage.ts` like
  `diploma_config`), `is_active`, `visible_to_students_and_parents` (default off).
- Exams and subjects a part names are checked to belong to the school on save. Exams are archived,
  never deleted; a subject removed later is reported as missing data, never an error.
- **Multi-year**: 2–6 distinct grade levels, each with a weight in (0, 100] (`numeric(5,2)`);
  weights are relative (40 + 60 is the same as 2 + 3).

## Equivalency rules

A rule set is a list of weighted **parts**; each turns one kind of record into a percentage:

| Part type       | Reads                                                                   | Becomes a percentage by                                 |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `exam_subjects` | per-subject external exam results ([external exams](external-exams.md)) | a grade → percentage table; the mean of counted results |
| `diploma_total` | the IB Diploma total of the latest finalized annual result (000262)     | a conversion (table or formula)                         |
| `gpa`           | the transcript's cumulative GPA, or the weighted GPA                    | a conversion                                            |
| `exam_total`    | the best total of one external exam (SAT, ACT…)                         | a conversion                                            |

- **Exam subjects**: a result's grade is the score of its exam's first component (a label such as
  "A\*", or a number such as IB's "7"), matched to the table without case or spaces. The best
  result per subject is kept (a resit counts if better). `required_subject_ids` always count; then
  the best of the rest up to `best_count` (empty: all). Fewer counted than `min_count` (default
  `best_count`) is missing data; a grade not in the table is a note and does not count.
- **Diploma total**: with `require_awarded` (the default in the example), a diploma not awarded
  gives no estimate (`not_eligible`) and a pending one is missing data.
- **GPA**: `gpa_basis` `gpa` or `weighted_gpa` (the GPA when nothing is boosted), worked out exactly
  as transcripts and graduation requirements do. While the current year is not finalized a note
  says the figure can still change.
- **Conversion**: `table` — the highest band whose minimum the value reaches gives its percentage
  (below every band: `not_eligible`); `linear` — intercept + slope × value, clamped to 0–100.
- **The estimate** is the weighted mean of the counted parts' percentages, two decimals, half up.
  A required part with missing data leaves it `incomplete`; an optional part that cannot count is
  left out (a note) and the other parts share its weight; any `not_eligible` required part makes it
  `not_eligible`. Each part reports its percentage, its share of the estimate, the value converted
  and (exam subjects) every result considered, counted or not.

Issue codes (`EquivalencyIssue.code`, with `kind` `missing`, `not_eligible` or `note`):
`NO_EXAM_RESULTS`, `TOO_FEW_SUBJECTS`, `REQUIRED_SUBJECT_MISSING`, `UNMAPPED_GRADE`,
`NO_DIPLOMA_RESULT`, `DIPLOMA_PENDING`, `DIPLOMA_NOT_AWARDED`, `NO_GPA`, `NO_EXAM_TOTAL`,
`BELOW_CONVERSION_TABLE`, `CURRENT_YEAR_PENDING`, `OPTIONAL_PART_SKIPPED`, `NO_PARTS`.

**Examples** (`EQUIVALENCY_EXAMPLES`, code only, copied into the editor on request and labelled as
examples): IGCSE / O Level best 8 (70) + A Level best 2 (30, optional); IB Diploma total by a
table (24 → 70 … 42 → 99, diploma required); American cumulative GPA by a table (70) + SAT by a
table (30, optional). Every number is a placeholder; the web picks the catalogue exams whose preset
matches (`igcse_letter`, `igcse_numeric`, `a_level`, `sat`).

**Which sets apply**: active sets listing the grade level of the student's latest placement
(without one, of their latest finalized year). The grade-level list estimates every student placed
in the grade that year under one set, whether or not the set lists the grade (it says so).

## Multi-year results

For each configured grade level the API finds the student's current finalized annual result in that
grade (a repeated grade: the later year). Each year is:

- `finalized` — its overall average and each subject's percentage (complete, not descriptive);
- `incomplete` — finalized, but the result is incomplete;
- `pending` — the student is in that grade now or has not reached it (by grade sort order);
- `missing` — the student went through that grade without a finalized result here (joined later).

The result is `complete` only when every year is finalized; `incomplete` once any year is missing
or incomplete; `pending` otherwise. Only a complete result carries the weighted overall (Σ weight ×
year average / Σ weights) and per-subject figures (the same mean over the years in which the
subject has a percentage, with `years_counted`); until then each year's own figures are shown.
Figures use the latest year's rounding rule. It applies to students whose latest placement is in
one of the configured grade levels.

Transcripts do not carry the multi-year result yet (the plan allows it as a later addition).

## Access

| Who                                            | Rule sets / configurations | A grade's list | A student's estimate / multi-year result |
| ---------------------------------------------- | -------------------------- | -------------- | ---------------------------------------- |
| School leadership (ORG_ADMIN, PRINCIPAL)       | read, create, edit, delete | read           | read (every applying one)                |
| Teachers (`academicConfig:read`, `grade:read`) | read                       | —              | read, for students they teach            |
| The student; linked parents (`grade:read`)     | —                          | —              | their own / their child's, shown only    |

No permission was added: `academicConfig:read` / `academicConfig:manage` / `grade:read` with the
row scope `app.can_read_student` (403, or 404 for a student outside the school), the same checks as
graduation requirements. A caller who is the student or a linked parent — and not staff over the
student — sees only sets and configurations with `visible_to_students_and_parents`. The tables are
configuration (tenant isolation only); the result and exam rows read keep their own role-scoped
policies. `app.equivalency_rule_subject_names(set_ids)` (SECURITY DEFINER) names the subjects parts
require, for staff or for shown sets; the student's own result subjects come through 000255's
`app.external_exam_result_subjects`.

Every write is audited (`equivalency_rule_sets`, `multi_year_result_configs`) with old and new
values.

## API

| Method | Path                                                                                    | Permission               |
| ------ | --------------------------------------------------------------------------------------- | ------------------------ |
| GET    | `/api/grading/equivalency-rule-sets`                                                    | `academicConfig:read`    |
| POST   | `/api/grading/equivalency-rule-sets`                                                    | `academicConfig:manage`  |
| PUT    | `/api/grading/equivalency-rule-sets/{setId}`                                            | `academicConfig:manage`  |
| DELETE | `/api/grading/equivalency-rule-sets/{setId}`                                            | `academicConfig:manage`  |
| GET    | `/api/grading/equivalency-rule-sets/{setId}/students?academic_year_id=&grade_level_id=` | `academicConfig:manage`  |
| GET    | `/api/grading/students/{studentId}/equivalency`                                         | `grade:read` + row scope |
| GET    | `/api/grading/multi-year-result-configs`                                                | `academicConfig:read`    |
| POST   | `/api/grading/multi-year-result-configs`                                                | `academicConfig:manage`  |
| PUT    | `/api/grading/multi-year-result-configs/{configId}`                                     | `academicConfig:manage`  |
| DELETE | `/api/grading/multi-year-result-configs/{configId}`                                     | `academicConfig:manage`  |
| GET    | `/api/grading/students/{studentId}/multi-year-results`                                  | `grade:read` + row scope |

A set or configuration is saved whole (`PUT` replaces its grade levels and parts or years). Parts
are checked by `validateEquivalencyParts` (400 with the messages); an exam, subject or grade level
from another school is unknown (400); a duplicate name is 409 `CONFLICT_DUPLICATE_ENTRY`. The web
builds the grade's CSV from the list (UTF-8 with BOM for Excel and Arabic).

## Privacy

The four tables hold configuration, not personal data, and have no `student_id`. Estimates and
multi-year results are computed on read from result and exam rows and never stored.
