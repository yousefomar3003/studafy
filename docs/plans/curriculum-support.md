# Plan: grading for every curriculum (IGCSE, A-Level, IB, American)

Status: in progress (started 2026-11-23). Branch: `feat/curriculum-support`.

## Goal

Studafy already lets a school build its own grade scales, result formats (percentage, out of N,
GPA), weighted assessments and descriptor grading. That covers day-to-day grading for most
curricula. This plan adds what the custom settings still cannot express, so an IGCSE, A-Level,
IB (MYP/PYP and DP subjects) or American school can set Studafy up the way it already works.

Everything is **opt-in per school**: a school that does not use a feature sees nothing new, and
nothing about existing results, report cards or transcripts changes.

## Scope

| WS  | Feature                                     | Covers                                          | Migration          | Branch                                 |
| --- | ------------------------------------------- | ----------------------------------------------- | ------------------ | -------------------------------------- |
| B   | Credit hours + weighted GPA (Honours/AP/HL) | American, IB                                    | 000253             | `feat/grading-credits-weighted-gpa`    |
| C   | Predicted grades                            | IGCSE, A-Level, IB                              | 000254             | `feat/grading-predicted-grades`        |
| D   | External exams and test scores              | SAT, ACT, AP, IELTS, TOEFL, Cambridge/IB finals | 000255             | `feat/grading-external-exams`          |
| A   | Curriculum templates                        | Everyone                                        | 000256 (if needed) | `feat/grading-curriculum-templates`    |
| E   | Class rank and percentile                   | American, Jordan, Egypt, everyone               | 000257             | `feat/grading-class-rank`              |
| F   | Graduation requirements checker             | American, any credit or exam-based diploma      | 000258             | `feat/grading-graduation-requirements` |

D also carries national and state exam presets: Jordan Tawjihi (التوجيهي), Egypt Thanaweya Amma
(الثانوية العامة) and a generic US state assessment (performance levels 1–4).

**Out of scope here (phase 2):** IB Diploma total out of 45 with the TOK / Extended Essay / CAS core
and bonus matrix; Cambridge/IB exam entries and entry fees through finance.

## Order and parallelism

1. **B, C and D run in parallel** (separate agents, separate git worktrees). They touch different
   tables and mostly different code. Shared hotspots are listed under "Integration".
2. **Integration:** merge B, C, D into `feat/curriculum-support`, then regenerate shared artifacts
   and run the full checks.
3. **A, E and F run in parallel after integration.** A needs B's credits and course levels; E
   ranks by B's weighted GPA too; F checks B's credits and D's exam results.

## Rules for every workstream

- Follow the existing architecture; no new frameworks. Read the code next to what you change first.
- Migrations: ordered SQL in `db/migrations`, the number assigned above, following
  `docs/database/migration-policy.md` (Expand only: new nullable columns or columns with defaults,
  new tables; never rewrite existing data). New tenant tables: `school_id uuid NOT NULL` with an FK
  to `app.schools(id)`, composite FKs `(id, school_id)` like their neighbours, created as
  `studafy_admin`, then `app.apply_tenant_isolation('app', '<table>')` (ADR-015). Grants as in
  neighbouring migrations.
- Finalized results are snapshots (ADR-017): new values a result depends on are copied onto the
  result rows / `config_snapshot` at finalization, never read live later.
- Issued transcripts and certificates are immutable `content` JSON. New fields are **additions**;
  readers treat a missing field as null so documents issued before this work still render.
- Authorization: fixed roles and `resource:action` permissions (ADR-002). Prefer existing
  permissions; if one is added, update `packages/constants` and regenerate the permission matrix
  doc (`bun run docs:generate` in that package).
- API: zod-openapi schemas like the existing grading routes. Regenerate `apps/api/openapi.json`
  (`bun run openapi:generate`), the web client (`bun run client:generate`) and the mobile client
  (`bun run mobile:client:generate`).
- UI text in English and Arabic: web `apps/web/src/lib/i18n/locales/{en,ar}/*.json`, mobile
  `apps/mobile/assets/translations/{en,ar}.json`.
- Mobile: teachers, students and parents are mobile-only roles. Unknown wire values must degrade
  gracefully (old app builds keep working).
- Tests: engine unit tests, API tests (the harness creates its own database per run; Postgres and
  Redis test containers are already running), web component tests where neighbours have them,
  Flutter tests where neighbours have them.
- **Never run `scripts/ci-local-db.sh` or `bun run db:down`**: they delete the shared test
  containers other workstreams are using. Do not run `db:migrate` against the shared database.
- Commits: Conventional Commits, small and focused, on the workstream branch only. No pushes.

## WS-B: credit hours and weighted GPA

**Data (000253)**

- `app.subject_configs`: `credits numeric(5,2) NULL` (0–100), `course_level text NULL`
  (a short label such as "Honors", "AP", "HL", "SL", at most 40 characters),
  `gpa_boost numeric(4,2) NOT NULL DEFAULT 0` (0–5).
- `app.student_subject_results`: `credits`, `course_level`, `gpa_boost`, `weighted_gpa_points`
  (all nullable, copied at finalization).
- `app.student_overall_results`: `weighted_result_value numeric(9,3) NULL`,
  `credits_attempted numeric(7,2) NULL`, `credits_earned numeric(7,2) NULL`.

**Rules (`packages/grading-engine`)**

- A subject's weighted GPA points = its band's GPA points + `gpa_boost`, only when the subject is
  passed (a failed subject keeps its points, usually 0). No band points means no weighted points.
- The overall GPA stays as it is (unweighted, weighted by the coefficient `average_weight`). When
  any counted subject has a boost, the overall also carries the weighted GPA, same weighting.
- Credits attempted = sum of `credits` over counted, complete subjects that have credits; credits
  earned = the same over passed subjects. Null when no counted subject has credits.
- `average_weight` stays the coefficient for averages and GPA. A validation warning is raised when
  a subject has credits that differ from its coefficient (the American template sets both equal).
- Cumulative (transcripts): weighted GPA and credit totals across years, same rules and the same
  "unavailable" reasons as the existing cumulative GPA.

**API / documents:** subject config read/write accepts the three fields; results, report cards,
certificates and transcripts expose credits, course level and weighted GPA where set.

**Web:** subject config editor fields (Credits, Course level, GPA boost) with help text; results and
transcript views show "GPA 3.6 (weighted 4.1)" and credits attempted/earned when present.

**Mobile:** results, parent child grades and transcript screens show the course level badge,
credits and the weighted GPA when present.

## WS-C: predicted grades

**Data (000254)**

- `app.grade_programs`: `predicted_grades_enabled boolean NOT NULL DEFAULT false`,
  `predicted_grades_visibility text NOT NULL DEFAULT 'staff'` (`staff` or
  `students_and_parents`).
- `app.student_predicted_grades`: school, academic year, optional term, student, subject,
  `grade_label` (≤ 40), optional `note` (≤ 1000), `entered_by_user_id`, timestamps. One current
  row per (school, year, term, student, subject); changes are audited.

**Rules:** when the subject's grade scale exists, the label must be one of its bands. Only enabled
grade programs accept predicted grades.

**Access:** a teacher of the section and subject sets them; school leadership can set any. Staff
with grade read access see them. Students and their linked parents see their own only when the
program's visibility is `students_and_parents`.

**API:** list and bulk-save for a section + subject (+ term); read a student's predicted grades.

**Web:** program setting (enable + visibility) in Academic setup; leadership view/edit in the
student overview.

**Mobile:** teacher entry screen from the class detail; read-only predicted grades for students and
parents when visible.

## WS-D: external exams and test scores

**Data (000255)**

- `app.external_exams` (a school's catalogue): code, name, `total_mode` (`sum`, `average`,
  `none`), optional total rounding step (IELTS rounds to 0.5), total min/max, `per_subject`
  (one result per subject, e.g. IGCSE or IB final results), `show_on_transcript`, archived flag.
- `app.external_exam_components`: name, `score_type` (`numeric` with min/max/step, or `label` with
  an ordered list of allowed labels), sort order.
- `app.student_external_exam_results`: student, exam, optional subject, date sat, computed total,
  note, recorded by, timestamps.
- `app.student_external_exam_scores`: one score per result and component.

**Built-in presets** (code, copied into a school's catalogue on demand, then editable): SAT
(Reading and Writing 200–800, Math 200–800, total 400–1600), PSAT, ACT (four sections 1–36,
composite average), AP (1–5 per subject), IELTS (four bands 0–9 step 0.5, overall average to 0.5),
TOEFL iBT (four sections 0–30, total 0–120), IGCSE final (A*–U and 9–1, per subject), A-Level final
(A*–U, per subject), IB DP final (1–7 per subject).

**Access:** school leadership manages the catalogue and records scores; staff with grade read
access see them; students and linked parents see their own.

**Transcripts:** exams with `show_on_transcript` appear in a new "External examinations" section,
stored in the transcript content at issue.

**Web:** Academic setup "External exams" tab (add preset, custom exam, archive); student overview
"Test scores" panel to record, edit and delete.

**Mobile:** read-only "Test scores" section for students and parents.

## WS-A: curriculum templates (after B)

Code-defined templates (`packages/grading-engine`), each with grade scale bands (labels, minimum
percentages, GPA points), result format, default assessment categories and weights, and optional
subject defaults (credits, course levels, boosts), predicted grades and external exam presets:

- National percentage (today's default)
- IGCSE 9–1 and IGCSE A*–G
- A-Level (A*–E)
- IB MYP: criteria A–D each out of 8, total out of 32 mapped to 1–7
  (boundaries 1–5 → 1, 6–9 → 2, 10–14 → 3, 15–18 → 4, 19–23 → 5, 24–27 → 6, 28–32 → 7)
- IB PYP: descriptors
- IB DP subjects: 1–7
- American: A+–F on 4.0 with credits, Honors (+0.5) and AP (+1)

Boundary percentages are sensible defaults the school edits. Applying a template to an academic
year and chosen grade levels creates the scales and program settings; it never overwrites an
existing configuration without an explicit confirmation. Web: a template picker in Academic setup.

## WS-E: class rank and percentile

Common in American transcripts and in Jordan and Egypt (top students, "الأوائل").

**Settings (000257, `app.grade_programs`):** `rank_enabled` (default false), `rank_basis`
(`average`, `gpa`, `weighted_gpa`), `rank_scope` (`section` or `grade_level`),
`rank_visibility` (`staff`, `students_and_parents`).

**Rules (`packages/grading-engine`, pure and unit-tested):**

- Ranked: students with a complete finalized result (term or annual) in the scope; incomplete
  results are not ranked and do not take a place.
- Ties share a rank and the next rank skips (1, 2, 2, 4). Rounding follows the program's overall
  rounding before comparing.
- Percentile: the share of ranked students with a lower value, as a whole-number percentage.
- Grade-level scope ranks only once every section of the grade level is finalized for that period;
  until then the API reports it as pending, never a partial rank.

**Storage:** rank is computed from finalized results on read (results change only through audited
corrections). Report cards, certificates and transcripts store the rank, cohort size and percentile
in their immutable content at issue, when enabled.

**API / web / mobile:** rank and percentile on results, a "top students" list per grade level and
period for leadership (web), and rank on the student and parent result screens when visible.

## WS-F: graduation requirements checker

**Data (000258):** `app.graduation_requirement_sets` (per school, name, applies to grade levels,
optional academic year from which it applies, active flag) and `app.graduation_requirements`
(rules). Subjects have no group today, so a rule names its subjects directly (a named subject group
inside the rule).

**Rule types:**

- Total credits earned ≥ N
- Credits earned in a named group of subjects ≥ N (e.g. "English": 4 credits)
- Specific subjects passed
- Cumulative GPA (or average) ≥ X
- An external exam recorded, optionally with a minimum total (e.g. Tawjihi, SAT)

**Rules (pure and unit-tested):** evaluate a student against a set using finalized annual results
across years (the same rows transcripts read) and D's exam results; per rule: met, not met (with
the gap, e.g. "2 of 4 English credits"), or pending (current-year results not finalized).

**API / web / mobile:** leadership manages sets in Academic setup; a per-student checklist in the
student overview; a grade-level report of students not on track. Students and parents see their own
checklist in the app when the school enables it. Transcripts can show "Graduation requirements met"
when issued.

## Integration

Shared hotspots, resolved when merging into `feat/curriculum-support`:

- `apps/api/openapi.json`, `packages/api-client` and the mobile generated client: take either side,
  then regenerate from the merged code.
- i18n JSON files (web and mobile), `packages/constants` permissions and the generated permission
  matrix: merge both sides' keys, regenerate.
- Transcript content builder: B changes subject/year/cumulative fields, D adds a separate
  top-level section.

After merging: `bun run ci:local`, the API integration tests for grades/academics, and Flutter
`analyze` + `test` for the mobile app.

## Progress

- [x] WS-B credits and weighted GPA
- [x] WS-C predicted grades
- [x] WS-D external exams and test scores
- [x] Integration of B, C, D
- [x] WS-A curriculum templates (`feat/grading-curriculum-templates`; no migration)
- [x] WS-E class rank and percentile (`feat/grading-class-rank`, migration 000257)
- [x] WS-F graduation requirements checker (branch `feat/grading-graduation-requirements`, migration 000258; `docs/modules/graduation-requirements.md`)
- [ ] Phase 2: IB Diploma points and core; exam entries
