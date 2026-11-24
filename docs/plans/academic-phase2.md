# Plan: academic phase 2 (Jordan and the Arab region)

Status: in progress (started 2026-11-24). Branch: `feat/academic-phase2` (from `dev` at b1bd0390).
Follows [curriculum-support.md](curriculum-support.md) (phase 1: credits and weighted GPA, predicted
grades, external exams, curriculum templates, class rank, graduation requirements).

## Goal

The academic features schools in Jordan and the wider Arab region still ask for: exam entries, the
IB Diploma total, Tawjihi equivalency, Arabic + English documents, ministry results export, results
across several years, lesson and term plans, learning outcomes, remedial plans, subject
coordinators, and exam weeks. Academic only: no payments, fees billing or messaging in this phase.

Everything is **opt-in per school**. A school that does not use a feature sees nothing new, and
existing results, report cards, certificates and transcripts are unchanged.

## The mobile rule (read this first)

`INSTRUCTOR`, `STUDENT`, `PARENT` and `ATTENDANCE_OFFICER` are **mobile-only roles**
(`MOBILE_ONLY_ROLES` in `packages/constants/src/roles.ts`): a teacher cannot open the web app.
So **every teacher-facing action in this plan is built in the Flutter app** (`apps/mobile`), and
every student/parent-facing view too. The web app is for school leadership (`ORG_ADMIN`,
`PRINCIPAL`, `FINANCE`) and the platform.

Mobile requirements for every workstream:

- New API fields are additions; the app parses them defensively (an absent field means an older
  server; an unknown enum value degrades to a neutral label, never a crash).
- New screens follow the existing feature structure (`features/<area>/{application,data,domain,presentation}`),
  Riverpod providers, the design kit, EN + AR strings in `apps/mobile/assets/translations/{en,ar}.json`,
  and RTL layout.
- Widget tests for each new screen; `flutter analyze` clean; full `flutter test` green.
- Run `bun run mobile:client:generate` and make sure the generated Dart client compiles. Known
  generator traps (seen in phase 1): a per-field `.openapi({ description })` on a referenced enum, a
  `.default()` on a shared enum, and `.extend()`/`allOf` all produce wrapper classes the generator
  cannot compile. Reference shared enums plainly and apply defaults in handlers.
- Only `dart format` the files you change (formatting the whole app rewrites ~50–370 unrelated
  files with this Flutter version).

## Workstreams

| WS  | Need (#)                                                  | Migration | Branch                          | Batch |
| --- | --------------------------------------------------------- | --------- | ------------------------------- | ----- |
| H   | Subject coordinators (#10)                                | 000261    | `feat/academic-coordinators`    | 1     |
| I   | Exam entries (#1)                                         | 000262    | `feat/academic-exam-entries`    | 1     |
| J   | IB Diploma 45-point total (#2)                            | 000263    | `feat/academic-ib-diploma`      | 1     |
| K   | Arabic + English documents (#4)                           | 000264    | `feat/academic-bilingual-docs`  | 1     |
| L   | Ministry results export (#5)                              | 000265    | `feat/academic-ministry-export` | 1     |
| M   | Exam weeks: timetable, rooms, seating, invigilators (#11) | 000266    | `feat/academic-exam-weeks`      | 1     |
| N   | Tawjihi equivalency (#3) + multi-year results (#6)        | 000267    | `feat/academic-equivalency`     | 2     |
| O   | Lesson and term plans (#7) + learning outcomes (#8)       | 000268    | `feat/academic-plans-outcomes`  | 2     |
| P   | Remedial plans (#9)                                       | 000269    | `feat/academic-remedial-plans`  | 2     |

**Batch 1** runs in parallel. **Batch 2** starts after batch 1 is merged into `feat/academic-phase2`:
O and P use H's coordinators for review and follow-up, and N converts J's IB total and phase 1's
external exam results.

Migration numbers are reserved here. Coworkers also add migrations on `dev`; if a number is taken
when a branch merges, renumber the unmerged one (none of these is applied anywhere before merge).

## Rules for every workstream

Same as phase 1 ([curriculum-support.md](curriculum-support.md), "Rules for every workstream"):
existing architecture only; expand-only migrations; tenant tables with `school_id` + composite FKs

- `app.apply_tenant_isolation` (ADR-015), registered wherever the RLS coverage, audit coverage,
  permission-guard, OpenAPI document, OpenAPI benchmark (`apps/api/tests/benchmark/openapi-generate-benchmark.test.ts`
  `EXPECTED_PATHS`) and horizontal-authz lists require; finalized results and issued documents are
  snapshots (ADR-017), new document fields are additions; fixed roles and `resource:action`
  permissions (ADR-002), prefer existing permissions; zod-openapi schemas; regenerate
  `openapi.json`, the web client and the mobile client; EN + AR strings (web `academicGrading.json`
  or a new namespace, then `bun run i18n:pseudo` in `apps/web`); tests at every layer; Conventional
  Commits ending with the Co-Authored-By line; never run `scripts/ci-local-db.sh`, `bun run db:down`,
  `docker compose rm` or `db:migrate` on the shared test database; commit type `merge:` is rejected.

## WS-H: subject coordinators (#10)

Not a new role (roles are a fixed enum, ADR-002): a **coordinator assignment** on top of an
existing staff role, usually `INSTRUCTOR`.

- **Data:** `app.subject_coordinators` (school, academic year, subject, user, optional grade levels
  it covers; none = all grades), unique per (year, subject, user). SQL helper
  `app.coordinates_subject(subject_id uuid, academic_year_id uuid) returns boolean` for RLS and the
  API, plus a TS helper `assertCoordinatesSubject` / `coordinatedSubjects(tx, user, year)`.
  **Batch 2 relies on these names; keep them.**
- **Access a coordinator gains, for their subjects and grades only:** read every section's marks,
  mark sheets, predicted grades and results (read-only; finalizing stays with leadership), and
  (batch 2) review plans and follow up remedial plans.
- **Web:** leadership assigns coordinators in Academic setup (per year, subject, grades).
- **Mobile:** a teacher who coordinates sees a "Coordinator" section: their subjects across all
  classes, each class's mark-sheet status and averages, and drill-down to marks (read-only).

## WS-I: exam entries (#1)

Builds on phase 1's external exams (`apps/api/src/modules/external-exams`, migration 000255).

- **Data:** exam sessions per catalogue exam (e.g. "IGCSE May/June 2027": series, entry deadline,
  results date), and entries per student (exam, session, subjects/components entered, tier where
  the exam has one, candidate number, status `draft` → `entered` → `withdrawn`, notes). Results
  recorded later link back to the entry.
- **Leadership (web):** create sessions, enter students in bulk (by grade, section or list), set
  candidate numbers, withdraw, export the entry list (CSV) for the exam board, see counts per
  subject.
- **Students and parents (mobile):** their entries (exam, session, subjects, candidate number,
  dates). No fees in this phase.

## WS-J: IB Diploma 45-point total (#2)

- **Engine:** a points-based overall result: sum of the best counted subjects' points (six DP
  subjects, each 1–7) plus core points from a configurable bonus matrix (TOK grade × Extended Essay
  grade, A–E, default = the published IB matrix as an editable default), max 45; CAS as complete /
  incomplete; configurable award conditions (minimum total 24, CAS complete, no "E" in TOK or EE,
  HL/SL point minimums and the failing-condition list as editable rules). Pure and unit-tested.
- **Settings:** per grade program: result format `points_total` with its maximum (45), the core
  components, the matrix and the conditions. Applied by the IB DP curriculum template too.
- **Data:** core component grades per student (TOK, EE, CAS) per year; predicted totals from phase 1
  predicted grades + predicted core grades.
- **Documents:** results, report cards, certificates and transcripts show the total, core points and
  diploma status (awarded / not awarded with the failing conditions).
- **Web:** settings, core grade entry for leadership/IB coordinator, results view.
- **Mobile:** students and parents see the total out of 45, core points, diploma status and the
  predicted total; teachers who are the IB coordinator (WS-H) or the subject teacher enter core
  grades (TOK/EE supervisors) from the app.

## WS-K: Arabic + English documents (#4)

- **Data:** Arabic names (optional) for students (`first_name_ar`, `middle_name_ar`, `last_name_ar`),
  subjects (`name_ar`), grade levels, sections, the school and its terms/years where shown on
  documents; and the school's document language setting: `en`, `ar` or `bilingual` per document
  type (report card, certificate, transcript).
- **Documents:** render in the chosen language, or bilingual (both names, both labels), with RTL for
  Arabic and the existing Noto Sans Arabic font. Snapshots store the names as issued.
- **Imports:** the student import mapping accepts the Arabic name columns.
- **Web:** edit Arabic names (students, subjects, grades, sections), document language settings,
  previews.
- **Mobile:** when the app is in Arabic, show Arabic student and subject names where the school has
  them (fallback to the English name); documents in the app follow the issued language.

## WS-L: ministry results export (#5)

Ministry formats differ and change, so this is a **configurable export**, not a hard-coded format.

- **Data:** export templates per school: target (free label, e.g. "Jordan MoE", "Noor", "eSIS"),
  file type (CSV / XLSX), encoding (UTF-8 with or without BOM for Excel Arabic), columns in order,
  each mapped to a field (student national ID or admission number, names EN/AR, grade, section,
  subject code or a per-subject mapping table, mark, percentage, grade label, term, year, status)
  with an optional value map (e.g. our grade labels → ministry codes).
- **Export:** per academic year + term (or annual) + grades/sections, from finalized results only;
  a preview of the first rows and a validation report (missing national IDs, unmapped subjects).
- **Built-in starting templates** clearly marked as editable examples, not official formats.
- **Web only** (leadership). No mobile change.

## WS-M: exam weeks (#11)

Do not confuse with the existing online exam tables (`app.exam_sessions`, 000102) or the phase 1
external exams; name the new tables accordingly (e.g. `exam_periods`, `exam_period_slots`).

- **Data:** exam periods (midterm, final… with dates and the grades they cover), exam slots (subject,
  grade/sections, date, start/end, linked to the gradebook assessment where there is one), rooms
  (reuse the school's rooms if a table exists, otherwise add one with capacity), seating (student →
  room → seat number, generated by a pure seating algorithm: by section, alphabetical or mixed, with
  capacity checks), invigilators (staff → slot → room) with clash detection (a teacher in two rooms,
  a student in two exams at once).
- **Web:** build the exam timetable, assign rooms, generate and adjust seating, assign invigilators,
  print seating lists and door sheets.
- **Mobile:** students and parents see their exam timetable with room and seat; teachers see their
  invigilation duties; all with dates in the school's timezone.

## WS-N: Tawjihi equivalency (#3) + multi-year results (#6) (batch 2)

The Ministry's conversion rules change, so **all rules are editable settings** with clearly marked
example defaults.

- **Equivalency:** per school, conversion rule sets by source system (IGCSE/A-Level from external
  exam results, IB from the WS-J total, American from GPA and SAT): which subjects count, how many,
  points per grade, the formula to a percentage. The result is a Tawjihi-equivalent percentage per
  student with a breakdown, labelled as an estimate the school confirms.
- **Multi-year results:** a weighted result across chosen years (e.g. grade 11 x% + grade 12 y%),
  per subject and overall, from finalized annual results.
- **Web:** rules, per-student breakdown, grade-level list. **Mobile:** students and parents see the
  estimate and the multi-year result when the school shows them.

## WS-O: lesson and term plans (#7) + learning outcomes (#8) (batch 2)

- **Learning outcomes:** a catalogue per subject and grade (code, text EN/AR, optional strand), set
  up by leadership on the web (import from CSV); outcome achievement levels per student per term
  (configurable scale, e.g. 1–4), entered by teachers in the app and shown on report cards when
  enabled.
- **Plans:** term (semester) plans per section + subject (weeks, units, outcomes, notes) and daily
  lesson plans (date/period from the timetable, objectives, outcomes, activities, resources linked
  to uploaded materials, homework, reflection), with status `draft` → `submitted` → `approved` /
  `returned` with comments.
- **Who:** teachers write plans **in the app**; coordinators (WS-H) and leadership review: in the
  app for coordinators, on the web for leadership. Leadership sees plan coverage (submitted on time,
  outcomes covered).

## WS-P: remedial plans (#9) (batch 2)

- **Data:** a plan per student + subject + term: reason (below the pass line from marks, or chosen by
  the teacher), target outcomes or skills, actions, review dates, progress notes, status `open` →
  `in_progress` → `achieved` / `closed`, optional parent visibility.
- **Suggestions:** students below the subject's pass percentage on current marks are suggested.
- **Who:** teachers create and update plans **in the app**; coordinators (WS-H) and leadership
  follow up (app / web); parents see the plan and progress in the app when the school shares it.

## Integration

Merge each batch into `feat/academic-phase2`, then regenerate shared artifacts (openapi.json, web
and mobile clients, pseudo-locale) and run the full checks: turbo lint/check-types/test, API
integration and security suites, fresh-database migrate + validate + RLS coverage, `flutter analyze`
and full `flutter test`. Hotspots: `apps/api/src/app.ts`, coverage/benchmark route lists, document
services (J and K both touch certificates, report cards and transcripts), i18n files,
`grading/schemas.ts`, mobile `academic_results_screen.dart`, translations.

## Progress

- [x] WS-H subject coordinators (`feat/academic-coordinators`, migration 000261; `docs/modules/subject-coordinators.md`)
- [x] WS-I exam entries ([docs/modules/exam-entries.md](../modules/exam-entries.md))
- [x] WS-J IB Diploma total (`feat/academic-ib-diploma`, migration 000263; docs/database/academic-grading.md "IB Diploma total")
- [x] WS-K Arabic + English documents (`feat/academic-bilingual-docs`, migration 000264;
      [module doc](../modules/bilingual-documents.md))
- [x] WS-L ministry results export (`feat/academic-ministry-export`, migration 000265; `docs/modules/ministry-export.md`)
- [x] WS-M exam weeks (`feat/academic-exam-weeks`, migration 000266; `docs/modules/exam-weeks.md`)
- [x] Integration of batch 1
- [x] WS-N Tawjihi equivalency + multi-year results (`feat/academic-equivalency`, migration 000267; [docs/modules/tawjihi-equivalency.md](../modules/tawjihi-equivalency.md))
- [x] WS-O lesson and term plans + learning outcomes (`feat/academic-plans-outcomes`, migration 000268; `docs/modules/lesson-plans-and-outcomes.md`)
- [x] WS-P remedial plans (`feat/academic-remedial-plans`, migration 000269; `docs/modules/remedial-plans.md`)
- [x] Integration of batch 2 (dev → stage still to do)
