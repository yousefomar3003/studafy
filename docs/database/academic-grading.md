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
| `approval:review`             | ORG_ADMIN, PRINCIPAL             | mark sheet approval queue                      |
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

## Policy decisions left to each school

Configured, not hard-coded: weights, structures, number of assessments, pass marks, final-exam rule,
scales and labels, rounding, missing/absent policies, retake rule and cap, coefficients, electives,
approval requirement and the supplementary allowance. Not yet configurable: custom labels for the
four academic statuses (they are translated in the apps), different rounding for term grades inside
an annual figure, and promotion rules beyond "number of failed subjects".
