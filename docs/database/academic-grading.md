# Academic grading: configuration, marks, results and certificates

Migration `000160_create_academic_grading_configuration.sql`, the pure calculation package
[`@studafy/grading-engine`](../../packages/grading-engine), and the API module
[`apps/api/src/modules/grading`](../../apps/api/src/modules/grading). The existing class gradebook
(000013/000052/000053, `modules/grades`) is unchanged and keeps serving class-level grading.

## Hierarchy

```text
school
└── academic year                       grading_config_status: draft → active → finalized → archived
    ├── grade scales (+ bands)           per year
    └── grade program                    a grade in that year: default scale, approval, promotion rule
        ├── subject config (grade default, section_id NULL)   ← inherited by every section
        │   ├── term weights · categories · assessments
        │   └── section override (section_id set)             ← replaces the default for one section
        └── sections → students (student_sections), electives/exemptions, teacher assignments
            └── marks → mark sheets (approval) → result finalizations (immutable) → certificates
```

## Grade defaults and section overrides

- A subject config with `section_id IS NULL` is the grade's default for that year. Sections read it
  **live**: there is no copy, so creating Section 8D later gives it every Grade 8 subject at once.
- A section override is its own `subject_configs` row with `section_id` set. Two partial unique
  indexes make duplicates impossible: one default per (year, grade, subject), one override per
  (section, subject).
- `POST /api/grading/sections/{id}/subjects/{subjectId}/override` with `customize` copies the
  default (rules, categories, term weights, every assessment that applies to the section) and moves
  that section's existing marks onto the copies. `exclude` creates an `is_excluded` row: the section
  does not offer the subject (refused once marks exist).
- An assessment row with `section_id` set on a grade default is an extra assessment for one section
  ("8C has an additional practical") without overriding anything else.
- Every grading-relevant change to a config increments its `revision`. An override stores the
  `based_on_revision` it was forked from; when the default moves on, the override is reported as
  **outdated** (overview, section list, publish check) — never silently changed. The admin either
  accepts the default (`/reset`: drop the override; refused if it has marks) or keeps the override
  (`/keep`: record the new revision as reviewed).
- `GET /api/grading/subject-configs/{id}/impact` lists inheriting sections (affected, with mark
  counts), overriding sections (unaffected, outdated flag) and sections with finalized results
  (protected). A save that would recalculate recorded marks is refused with
  `ACADEMIC_CONFIG_IMPACT_UNCONFIRMED` until it is resent with `confirm_impact: true`.

Sources a section's subject can have: `inherited`, `override`, `section_only` (a subject only that
section takes), `excluded`.

## Year scoping and history

Scales, programs, configs, assessments, teacher assignments and mark sheets all carry the academic
year; foreign keys pin terms and sections to the same year. Next year's Grade 8 Mathematics is a
different row from this year's.

- **Copy a year** (`POST /api/grading/years/{target}/copy`): scales, programs, sections (matched by
  grade and name), configs with categories/term weights/assessments, overrides and optionally
  teacher assignments. Terms map by `sequence_number`; assessment dates are cleared. Never copied:
  marks, sheets, finalizations, certificates, placements, electives. The target must be a draft with
  no configuration and stays a draft for review.
- **Status**: `draft` accepts unfinished configs (validation issues are returned) and no marks;
  publishing to `active` runs every validation and refuses on any error; `active → draft` only
  before the first mark; `active → finalized` requires every populated section's annual results to
  be finalized; `finalized`/`archived` make configuration read-only.
- **Finalization** writes `result_finalizations` plus one immutable row per student and subject
  (`student_subject_results`) and per student (`student_overall_results`). Each subject row stores
  `config_snapshot` — the complete engine configuration it was computed with, including the
  promotion policy and scale — and `breakdown`, the engine's output. `studafy_app` has only `SELECT,
INSERT` on result rows; a trigger allows a finalization to change only from `finalized` to
  `superseded`.
- **Marks inside finalized results are locked** by `trg_student_marks_finalized_lock` (a term
  finalization locks that term's assessments, an annual one all of them). The only way through is
  the correction workflow, which sets `app.result_correction` for its own transaction.
- **Correction** (`POST /api/grading/finalizations/{id}/corrections`): applies the corrected marks
  (audited old → new), recomputes every student **with the stored snapshots**, writes version n+1
  (`supersedes_id`, mandatory `correction_reason`) and supersedes the old version. Today's
  configuration is never used to recompute an older result.

## Assessments, marks and approval

- No mark row means "not yet graded". A row's `status` is `graded` (with a score), `absent`,
  `excused` or `not_applicable`; `attempt = 2` is a retake/supplementary sitting.
- Mark entry needs an active year, a teacher of that section and subject (explicit
  `section_subject_teachers` assignment, or teaching one of the section's classes in a course of
  that subject) or leadership, an assessment that applies to the section, a student who takes the
  subject (mandatory: everyone placed; optional/elective: `enrolled` in
  `student_subject_enrollments`; `exempt` students take none), and a score within 0..max.
- Mark sheets: per section, subject and period (a term, or annual). Submitting requires every
  enrolled student to have a usable mark on every mandatory assessment of the period. `submitted`
  and `approved` sheets lock their marks; leadership approves, returns (with reason) or reopens. A
  grade program with `mark_approval_required = false` approves on submit.
- One assessment at a time (000229, `app.assessment_mark_releases`): a teacher can send a single
  assessment (say the first exam) for the same approval as soon as every enrolled student has a
  recorded, usable mark for it (no mark, or an absence the school does not count as zero, is
  missing; optional assessments and `missing_mark_policy = zero` do not excuse a gap here). Its
  marks lock while it waits and once approved; once approved they are released to the student and
  linked parents exactly like an approved sheet's (`app.is_released_student_mark`: the period's
  sheet is approved **or** the assessment's own release is). A single assessment **always** waits
  for leadership, also in a grade program whose sheets need no approval step (that setting only
  approves whole sheets on submit). Changing a mark of a returned assessment puts it back to draft
  (the row is deleted, audit-logged). Nothing else moves: the period's sheet still needs every mark
  before it can be submitted, finalization still needs approved sheets, and no term figure is ever shown to
  families before finalization. Rules between the two:
  - Sending a single assessment is refused while its period's sheet is submitted or approved.
  - Approving the period's sheet also approves any of its assessments still waiting on their own.
  - Returning or reopening the sheet does **not** un-release assessments approved on their own:
    families have seen those marks, and they stay released and locked until leadership withdraws
    that assessment (decision `reopen`, with a reason), which hides them again and hands them back
    to the teacher. Withdrawing is refused while the sheet is approved (reopen the sheet first) and
    inside finalized results (correction workflow).
  - A student who joins the section after an assessment was released cannot be given a mark for it
    until leadership withdraws it (the same as an approved sheet, which must be reopened).
- Families are told (000230): each approval -- a whole sheet (on approval, or on submit where the
  program needs no approval step) or one assessment -- raises one `marks.released` outbox event in
  the approval's transaction. The workers' notify consumer turns it into one MARKS_RELEASED inbox
  notice for each of the section's students with a mark in what was released and each of their
  linked parents ("First exam marks are out for Mathematics" / "Mathematics – Term 1 marks are
  released"), deep-linking to `/students/{studentId}/marks`; the push consumer sends it to their
  phones under their push preference and quiet hours. Never emailed. A sheet approval that also
  approves pending single assessments raises one event, not one per assessment; an event whose
  marks were withdrawn before it was read sends nothing.
- Teachers may add assessments for their section when the subject allows it; with
  `teacher_assessments_require_approval` they stay `proposed` (not counted) until approved.

## Grading formulas (`@studafy/grading-engine`)

Assessment: `p = score / max × 100`, after the school's policies:

| Situation                       | Counts as                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| no mark, optional assessment    | left out                                                                                         |
| no mark, mandatory              | **missing** → result incomplete (or 0 if `missing_mark_policy = zero`)                           |
| excused / not applicable        | left out; its weight goes to the rest of the category                                            |
| absent                          | missing, or 0 if `absent_policy = zero`                                                          |
| graded retake (`retake_policy`) | `replace`: retake · `highest`: max(original, retake) · `capped`: max(original, min(retake, cap)) |

Category (per term for term-scope categories): `weighted_average` = Σ p·w / Σ w over counted
assessments (after dropping the `drop_lowest` lowest); `total_points` = Σ points / Σ max × 100.

Weighted method:

```text
term %   = Σ (category % × category weight) / Σ weights of categories with gradeable work
annual % = Σ (term % × term weight) + Σ (annual category % × weight), divided by the weights used
```

A category or term with nothing gradeable (everything excused) drops out and its weight is spread
over the rest. Total-points method: `% = Σ points earned / Σ maximum points` over every counted
assessment in scope.

Validation (blocks publication; blocks saving while active): term-scope category weights total 100;
term weights + annual category weights total 100 (tolerance 0.001); each weighted category has
assessments in every weighted term; an assessment's term matches its category's scope; no
assessment in a zero-weight term; `drop_lowest` smaller than the number of assessments; a final-exam
rule needs a final-exam category; a capped retake needs a cap; scale bands start at 0, have distinct
lower bounds and labels, all within 0–100. Because a band runs from its lower bound to the next one,
bands cannot overlap or leave gaps.

Subject result: incomplete if any mandatory assessment in scope is missing (then `percentage`,
marks, grade and pass/fail are all null — previews show `provisional_percentage`, labelled as such).
Otherwise `percentage = round(raw)` with the subject's decimals and mode (`half_up`, `half_even`,
`floor`, `ceil`); `marks_obtained = round(raw × max_marks / 100)`; grade label from the scale (none
if the subject has no scale); **pass** when `percentage ≥ pass_percentage` and, if
`final_exam_pass_percentage` is set, every final-exam category in scope reaches it on its own.
Rounding is applied once, to the final figure; term grades shown inside an annual result are rounded
for display, the annual figure is computed from unrounded term values.

Overall: subjects counted in the average (`include_in_average`, not exempt); if any counted subject
— or any mandatory/elective subject — is incomplete, the overall result is incomplete. Otherwise
`average = Σ % × average_weight / Σ average_weight` (program rounding), totals sum marks obtained and
max marks, failures count mandatory and elective subjects only, and the academic status is
`promoted` (0 failures), `supplementary` (≤ `max_failed_subjects_for_supplementary`) or `retained`.

### Credits, course levels and the weighted GPA (000253)

For American and IB schools a subject config may also carry `credits` (credit hours, 0–100; null
when the school does not use them), `course_level` (a label such as "Honors", "AP", "HL", ≤ 40
characters) and `gpa_boost` (0–5, default 0). All three are opt-in; a school that leaves them empty
sees no change anywhere.

- **Weighted points** (per subject): `gpa_points + gpa_boost` when the subject is passed; its plain
  `gpa_points` when failed. Null when the subject has no boost, is incomplete or its band has no GPA
  points. Descriptive subjects never have a boost.
- **Weighted GPA** (overall): only for a GPA result (`result_format = gpa`) with at least one counted
  subject boosted. The same mean as the GPA (`Σ points × average_weight / Σ average_weight`, program
  rounding) with each boosted subject's weighted points; null whenever the GPA is null. The GPA
  itself never changes.
- **Credits attempted / earned**: the credits of every complete, non-exempt subject that carries
  credits, and of those passed — including subjects left out of the average (PE, electives) and
  descriptive (pass/fail) subjects, which earn their credits when passed (no descriptor marked "not
  achieved"), as in American schools. Null when no such subject carries credits. The average, GPA
  and weighted GPA still count only the subjects in the average. `average_weight` remains the
  coefficient that weights the average and GPA; a subject whose credits differ from it gets the
  `CREDITS_DIFFER_FROM_COEFFICIENT` warning.
- Until WS-F (000258) credits counted only the subjects in the average. Results finalized before
  then keep the totals stored on `student_overall_results` (snapshots, never recomputed); new
  finalizations, previews, and the cumulative credits of transcripts issued from then on (worked
  out from the subject rows) use the rule above.
- Changing `credits` or `gpa_boost` on a config with marks asks for impact confirmation like the
  coefficient; `course_level` is a label and does not.

Finalization snapshots `credits`, `course_level`, `gpa_boost` and `weighted_gpa_points` on each
`student_subject_results` row (also in `config_snapshot`), and `weighted_result_value`,
`credits_attempted` and `credits_earned` on `student_overall_results`. Section overrides, copied
years and the exam-structure rebuild carry the three config fields over. Rows finalized before 000253
read back with all of them null. Transcripts add the cumulative weighted GPA (same unavailable
reasons as the cumulative GPA) and cumulative credits; certificates and transcripts gain the subject
and overall fields only when they are set, so documents issued earlier still render unchanged.

## Curriculum templates

Built-in starting points for a whole curriculum, defined in code
(`packages/grading-engine/src/templates.ts`, no table): each template carries a grading scale (or,
for descriptive templates, a descriptor scale), the result format and its maximum, the overall and
subject rounding, the subject pass mark and maximum marks, the default categories and weights, and
optional subject credits (and the course levels a subject can be given afterwards). Names, band
labels and category names exist in English and Arabic.

| Template                   | Scale                                                                                     | Result     | Subjects                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| National percentage        | Excellent 90 … Pass 50, Fail                                                              | percentage | pass 50; the school's exam system (School Settings)                                                                             |
| IGCSE 9–1 / A\*–G, A-Level | 9…1 / A\*…G / A\*…E in steps of 10%, U                                                    | percentage | pass 40; homework 10, classwork 15, tests 25, end-of-term exam 50                                                               |
| BTEC                       | Distinction\* 90, Distinction 75, Merit 60, Pass 40, Unclassified                         | percentage | pass 40; assignments 70, practical 30                                                                                           |
| British Key Stages, IB PYP | descriptors (Greater depth / Expected / Working towards; Exceeding … Beginning)           | percentage | descriptive, one "Attainment" skill per term                                                                                    |
| IB MYP                     | 1–7 at totals 0, 6, 10, 15, 19, 24, 28 of 32 (as % of 32), GPA points 1–7                 | GPA of 7   | total points; criteria A–D out of 8 per term; max marks 32; pass at grade 3; 3-decimal rounding                                 |
| IB DP subjects             | 7 80, 6 70, 5 60, 4 50, 3 40, 2 25, 1                                                     | GPA of 7   | pass 40; internal assessment 25, tests 25, end-of-term exam 50; HL/SL as course levels                                          |
| American                   | A+ 97 (4.0) … D 65 (1.0), F (0.0)                                                         | GPA of 4   | pass 65; tests 40, quizzes 20, homework 15, classwork 15, projects 10; 1 credit = coefficient 1; Standard / Honors +0.5 / AP +1 |
| French                     | Très bien 80, Bien 70, Assez bien 60, Passable 50, Insuffisant                            | out of 20  | max marks 20, pass 50; the school's exam system                                                                                 |
| Irish Junior Cycle         | Distinction 90, Higher Merit 75, Merit 55, Achieved 40, Partially Achieved 20, Not Graded | percentage | pass 40; the school's exam system                                                                                               |
| Irish Leaving Certificate  | H1 90 … H7 30, H8                                                                         | percentage | pass 40; the school's exam system                                                                                               |

Boundaries are defaults, not awarding-body boundaries; the school edits them like any other scale.

`POST /api/grading/years/{yearId}/curriculum-template/preview` and `.../apply` take a template and a
list of grade levels (`academicConfig:manage`; `GET /api/grading/curriculum-templates` lists them).
Applying:

1. creates the template's scale in the year (named after the template), reuses one with that name
   and the same bands, or replaces the bands of one with that name;
2. creates or updates each grade program: scale, result format and maximum, overall rounding, and
   the descriptor scale for descriptive templates;
3. rebuilds each grade default subject on the template (method, maximum marks, pass mark, rounding,
   categories with one assessment per term, equal term weights, credits where the template sets
   them; the subject then inherits the grade's scale). Requirement, average and certificate flags,
   policies and instructions are kept.

Every write goes through the ordinary services (`createScale`, `upsertProgram`,
`updateSubjectConfig`), so validation, revisions, the impact check and their audit entries apply, and
one `curriculum_template_applied` audit entry summarises the apply. The preview reports each step as
create / update / unchanged; when anything that already exists would change, `requires_confirmation`
is true and the apply is refused with `ACADEMIC_CONFIG_IMPACT_UNCONFIRMED` unless it is resent with
`confirm: true`. Never touched: subjects with recorded marks (`has_marks`), grade defaults with
section-only assessments, section overrides, and every subject when the year has no terms yet. A
grade or subject the rules refuse is reported (`error` / `invalid`) and the rest still applies.
Which template a grade came from is not recorded: subjects added later start from the school's exam
system, and applying the template again brings them in line (it is idempotent).

### Class rank and percentile (000257)

For American transcripts and the top students ("الأوائل") of Jordanian and Egyptian schools, a grade
program may rank its students. Four columns on `app.grade_programs`, copied with the year:

| Column            | Values                           | Default   |
| ----------------- | -------------------------------- | --------- |
| `rank_enabled`    | true / false                     | `false`   |
| `rank_basis`      | `average`, `gpa`, `weighted_gpa` | `average` |
| `rank_scope`      | `section`, `grade_level`         | `section` |
| `rank_visibility` | `staff`, `students_and_parents`  | `staff`   |

Rules (`@studafy/grading-engine` `calculateRanks`, pure and unit-tested):

- **Who is ranked**: students with a complete overall result in the cohort. An incomplete result (or
  one without a value on the basis, e.g. a GPA with a subject that has no GPA points) takes no place
  and is not counted in the cohort size.
- **Basis**: `average` ranks by `average_percentage`; `gpa` by the GPA (`result_value` of a GPA
  result); `weighted_gpa` by `weighted_result_value`, falling back to the plain GPA for a student
  without a boosted subject (000253 stores the weighted GPA only then). A GPA basis needs
  `result_format = gpa`: the API refuses it otherwise (400 `VALIDATION_FAILED`, from the engine's
  `RANK_BASIS_NEEDS_GPA` issue), also when the format is what changes, and
  `ck_grade_programs_rank_gpa_basis` backs it up.
- **Ties**: values are compared after the program's overall rounding; equal values share a rank and
  the next rank skips (1, 2, 2, 4).
- **Percentile**: the share of ranked students with a strictly lower value, as a whole-number
  percentage rounded down (the top of 200 is the 99th; a cohort of one is the 0th).
- **Scope**: `section` ranks a section's current finalization of the period (a term, or the year);
  `grade_level` ranks every section of the grade together, and only once every section that has
  students (and is not archived) has a current finalization for the period. Until then the rank is
  `pending`, never a rank among the sections that happen to be done. A student finalized in two
  sections of the grade for the same period (they moved) counts once, with the later finalization.

Rank is **computed on read**, never stored on results: from the current (not superseded) finalized
overall results, which change only through audited corrections. A correction therefore re-ranks the
whole cohort, and a superseded finalization has no rank. The rank settings are live configuration
(not part of `config_snapshot`): turning ranking on or off, or changing its basis or scope, changes
what results show from then on, but never an issued document.

Reading a cohort is one query through `app.class_rank_cohort(year, grade_level, term, section)`
(SECURITY DEFINER). A student's rank depends on classmates' results that RLS keeps from the student
and their parents, so the function returns the cohort's sections, current finalizations and overall
values itself; it returns nothing unless the grade ranks and the caller is leadership or the rank is
`students_and_parents`, and names only the students whose results the caller may read
(`app.can_read_student_result`): a student sees their own row and anonymous values. It uses the
existing indexes (`uq_sections_school_year_grade_name`, the partial current-finalization unique
indexes, `uq_student_overall_results_finalization_student`).

Where it shows (`class_rank`: `status` `ranked` / `not_ranked` / `pending`, `basis`, `scope`,
`rank`, `cohort_size`, `percentile`; null when off, hidden from the caller, or superseded):

- Staff: the finalization detail (`GET /api/grading/finalizations/{id}`) and leadership reading a
  student's results. Top students (`GET /api/grading/years/{yearId}/programs/{gradeLevelId}/top-students`,
  `result:finalize`): the best `limit` places with ties included (every student ranked ≤ limit),
  one list for a grade-level rank or one per section for a section rank, for a term or the year.
- Students and parents (`GET /api/grading/students/{id}/results`): only when `rank_visibility` is
  `students_and_parents`.
- Documents: report cards, certificates and transcripts store `overall.class_rank` (`rank`,
  `cohort_size`, `percentile`, `basis`, `scope`) in their immutable content at issue, when the grade
  ranks, the rank is visible to students and parents (the documents are issued to them) and the
  student was ranked. Absent otherwise and on documents issued before 000257.

## Certificates and report cards

Issued from a **current** finalization: annual → `annual_certificate`, term → `term_report`. Only a
complete overall result is certifiable; incomplete students are reported as blocked with reasons.
The certificate's `content` is rendered once at issue time from the stored results (school, year,
term, student, grade and section, every subject flagged `include_on_certificate` with marks, maximum,
percentage, grade, pass and term results, overall figures and status, finalization version, serial,
issuer) and stored with its SHA-256 (`content_sha256`, over the JSON as rendered). Certificates are
never edited: a trigger allows only `issued → superseded` (reissue, with reason and a link to the
replaced certificate) or `issued → revoked` (with reason). After a correction, the old certificate
shows `needs_reissue` until reissued.

## Permissions and visibility

| Permission                    | Held by                          | Gates                                          |
| ----------------------------- | -------------------------------- | ---------------------------------------------- |
| `academicConfig:read`         | ORG_ADMIN, PRINCIPAL, INSTRUCTOR | reading configuration, my assignments          |
| `academicConfig:manage`       | ORG_ADMIN, PRINCIPAL             | all configuration writes, proposed assessments |
| `grade:read` / `grade:update` | (existing)                       | mark sheet read / mark entry, submit           |
| `approval:review`             | ORG_ADMIN, PRINCIPAL             | mark sheet and single-assessment approval      |
| `result:finalize`             | ORG_ADMIN, PRINCIPAL             | preview, finalize, corrections                 |
| `academicCertificate:issue`   | ORG_ADMIN, PRINCIPAL             | issue, reissue, revoke, list certificates      |

Row scope is enforced in the database as well as the API. All 15 tables are tenant-isolated
(`apply_tenant_isolation`, immutable `school_id`) with composite school-keyed foreign keys.
`student_marks` is readable only by leadership or a teacher of that student's section in that
subject (`app.can_read_student_mark`); results and certificates by leadership, the student, linked
parents, or a teacher assigned to the section (`app.can_read_student_result`). 000160 extends
`app.can_read_subject` and `app.can_read_student` so a teacher assigned through
`section_subject_teachers` sees that subject and the section's students, as class teachers already
did. Every write emits an `app.audit_logs` row in the same transaction; mark changes record old and
new values.

Predicted grades (000254) are a separate, opt-in table per grade and year that nothing above reads;
see [`docs/modules/predicted-grades.md`](../modules/predicted-grades.md).

### Subject coordinators (000260)

`app.subject_coordinators` (+ `app.subject_coordinator_grade_levels`) names who coordinates a
subject in a year, optionally for some grade levels. A coordinator reads every covered section's
marks, predicted grades and subject results, read-only, through `app.coordinates_section_subject`
and its siblings; see [`docs/modules/subject-coordinators.md`](../modules/subject-coordinators.md).

### Learning outcomes and plans (000267)

`app.learning_outcomes` is a catalogue per subject and grade level; `app.student_outcome_achievements`
holds a teacher's level per student, outcome and period. When a school shows outcomes on report
cards, finalization copies the period's achievement into the append-only
`app.finalized_outcome_achievements`, which results and report cards read. Term and lesson plans
(`app.term_plans`, `app.lesson_plans` and their parts) are staff-only; see
[`docs/modules/lesson-plans-and-outcomes.md`](../modules/lesson-plans-and-outcomes.md).

## Policy decisions left to each school

Configured, not hard-coded: weights, structures, number of assessments, pass marks, final-exam rule,
scales and labels, rounding, missing/absent policies, retake rule and cap, coefficients, electives,
approval requirement and the supplementary allowance. Not yet configurable: custom labels for the
four academic statuses (they are translated in the apps), different rounding for term grades inside
an annual figure, and promotion rules beyond "number of failed subjects".
