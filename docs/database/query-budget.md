# Query performance pass (ST-284): budget, methodology, and findings

Pre-launch query-performance pass: what was reviewed, what changed, and the honest result — including
where the result is "already fine, now proven" rather than "found and fixed a bug." Read
[migration-policy.md's indexing standard](./migration-policy.md#indexing-standard) first; this doc
does not repeat those rules, it applies them to twenty real query shapes and records the evidence.

## Scope and what "top 20" means here

The ticket asks for pg_stat_statements review on staging load, missing indexes, N+1 fixes, and
EXPLAIN budget checks for the top 20 queries. Staging has never run (see
[`docs/testing/load-test-scenarios.md`](../testing/load-test-scenarios.md)'s own honesty note), so
there is no staging `pg_stat_statements` sample to review — that gap is real and is listed under
[Known gaps](#known-gaps), not silently worked around. What this pass could do, and did:

1. Read every migration in `db/migrations` (110 files at the time of this pass) to build the actual
   index inventory, and cross-referenced it against the real WHERE/ORDER BY/JOIN shapes `apps/api`
   issues for its highest-traffic endpoints — not a synthetic query list.
2. Selected the twenty query shapes below because each is either named directly in
   [`docs/testing/load-test-scenarios.md`](../testing/load-test-scenarios.md) or
   `infra/load-tests/scenarios/*.js` (attendance batch write, published grades read), or is the
   primary access path of a hot list/detail endpoint (notifications inbox, gradebook entry, a
   student's attendance/AI/finance history) on a table that grows without bound in production
   (per-record, per-message, per-notification, per-session).
3. Committed those twenty as a real, running EXPLAIN check —
   [`packages/db/tests/query-plan-budget.test.ts`](../../packages/db/tests/query-plan-budget.test.ts)
   — rather than a one-time manual check whose result rots the moment a later migration changes an
   index.

## Methodology: `EXPLAIN` with `enable_seqscan = off`, not `EXPLAIN ANALYZE` on production-scale data

This repo has no staging and no production-scale dataset to run `EXPLAIN ANALYZE` against. The demo
seed (`db/seeds/`) is intentionally small — a handful of rows per table — so on row count alone the
planner would legitimately prefer a Seq Scan on every one of these tables regardless of whether a
usable index exists. That would prove nothing about index coverage.

`db/seeds/index-health.ts` already established the fix for this, for its own smaller probe set:
`SET LOCAL enable_seqscan = off` before running `EXPLAIN (FORMAT JSON)`. With sequential scan
disabled, the planner is forced to use an index if one can serve the predicate at all; if the plan
still falls back to Seq Scan, no index covers that predicate — a real, structural gap that will
matter once the table is actually large, not a false alarm from a three-row fixture.
`query-plan-budget.test.ts` reuses this exact technique (duplicated locally rather than importing
`index-health.ts`'s private helpers, matching this repo's existing convention of small
single-purpose test files — see `attendance-benchmark.test.ts` and its siblings).

This is a **plan-shape check**, not a timing benchmark. It asserts _what access path the planner
would choose_, not how many milliseconds a query takes — timing on a disposable, unrepresentatively
small database would not mean anything for production latency. `statement_timeout` (30s,
[`docs/runbooks/postgres-conventions.md`](../runbooks/postgres-conventions.md)) and
`log_min_duration_statement` (1s) remain the production-scale backstops; this test is a structural
guarantee that sits underneath them — an index exists before a slow query ever has the chance to hit
that timeout.

## The twenty query shapes

Each row names the real call site, the exact predicate probed, the table's reason for being "large"
in production, and the index that serves it. Every index listed was read directly from the migration
that created it — none were invented for this pass.

| #   | Query shape (probe name in the test)           | Real call site                                                                                                                        | Table grows because...                                           | Serving index                                                       |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `notifications_unread_inbox`                   | notifications module, unread inbox                                                                                                    | every notification ever sent to every user                       | `idx_notifications_school_user_unread` (partial, `read_at IS NULL`) |
| 2   | `notifications_full_history`                   | notifications module, paginated history                                                                                               | same                                                             | `idx_notifications_school_user_created`                             |
| 3   | `enrollments_by_class`                         | `attendance-session-service.ts` roster read                                                                                           | one row per student per class per term                           | `idx_enrollments_school_student_class`                              |
| 4   | `material_chunks_by_material`                  | `ai/summary/materials.ts` `loadSummaryMaterial`                                                                                       | one row per ingested chunk per material                          | `uq_material_chunks_material_chunk`                                 |
| 5   | `attendance_records_by_session`                | `attendance-session-service.ts` roster read/write                                                                                     | one row per student per session, every day, forever              | `idx_attendance_records_school_session_student`                     |
| 6   | `attendance_records_by_student_history`        | a student's attendance history                                                                                                        | same                                                             | `idx_attendance_records_school_student_created`                     |
| 7   | `attendance_sessions_by_class_date`            | attendance session open/list                                                                                                          | one row per class per period per day                             | `idx_attendance_sessions_school_class_date`                         |
| 8   | `grade_submissions_by_gradebook`               | `grade-entry-service.ts` `getSubmissionsWithGrades` / `ensureDraftSubmissions`                                                        | one row per student per gradebook                                | `idx_grade_submissions_school_gradebook_id`                         |
| 9   | `grades_by_submission`                         | `grade-entry-service.ts` `getSubmissionsWithGrades`                                                                                   | one row per assessment per submission                            | `idx_grades_school_grade_submission_id`                             |
| 10  | `grade_submissions_pending_queue`              | `approval-queue-service.ts`                                                                                                           | same as #8, filtered to one status                               | `idx_grade_submissions_school_status_submitted_at`                  |
| 11  | `student_term_summaries_by_student`            | published grades / results-day read storm ([`results-day-read-storm.js`](../../infra/load-tests/scenarios/results-day-read-storm.js)) | one row per student per term, read heavily right after publish   | `idx_student_term_summaries`                                        |
| 12  | `assignments_by_class_due`                     | assignment list for a class                                                                                                           | one row per assignment per class                                 | `idx_assignments_school_class_due_at`                               |
| 13  | `assignment_submissions_by_student_assignment` | a student's submission for one assignment                                                                                             | one row per student per assignment                               | `idx_assignment_submissions_school_student_assignment`              |
| 14  | `exam_results_by_student_exam`                 | a student's result for one exam                                                                                                       | one row per student per exam                                     | `idx_exam_results_school_student_exam`                              |
| 15  | `timetable_slots_by_version`                   | render one timetable version                                                                                                          | one row per period per class per week                            | `idx_timetable_slots_school_version_id`                             |
| 16  | `timetable_slots_by_class`                     | a class's weekly periods                                                                                                              | same                                                             | `idx_timetable_slots_school_class_id`                               |
| 17  | `invoice_cache_by_student`                     | `finance/family/service.ts` family finance view                                                                                       | one row per invoice per student, synced from ERPNext             | `idx_invoice_cache_school_student_id`                               |
| 18  | `payment_cache_by_student`                     | `finance/family/service.ts` family finance view                                                                                       | one row per payment per student                                  | `idx_payment_cache_school_student_id`                               |
| 19  | `ai_conversations_by_student`                  | a student's AI conversation list                                                                                                      | one row per conversation, unbounded per student                  | `idx_ai_conversations_school_student_created_at`                    |
| 20  | `ai_messages_by_conversation`                  | one AI conversation's message history                                                                                                 | one row per message, the largest of these tables by construction | `idx_ai_messages_school_conversation_created_at`                    |

**Result: all twenty are already index-served. No seq scan appears on any probe.** This pass did not
find a missing index among these twenty — it is recorded that way rather than manufactured otherwise.
`db/migrations`' existing indexing discipline (every migration's own "why this index" comment, audited
while building this list) is the reason: FK-backing and hot-predicate indexes were added at the same
time as the tables that needed them, not retrofitted later. This pass's contribution is turning that
into a **committed, running proof** instead of a one-time read of 110 files that nobody re-checks the
next time a query shape changes.

If a future change to one of these twenty call sites (a new filter column, a different sort) stops
matching its index's leading columns, `query-plan-budget.test.ts` fails with the specific probe name
and the `EXPLAIN` node type it fell back to — not a silent regression discovered in production.

## N+1 fixes (dataloader pattern)

This codebase has no ORM and no GraphQL layer, so "dataloader pattern" here means the same thing the
codebase's own existing code already does in several places (`listAttachmentsByAssignment` in
`apps/api/src/modules/academics/assignments/attachment-service.ts`,
`finance/family/service.ts`'s per-family batch queries): **one batched query keyed by an array of
parent ids, grouped into a `Map` in memory, instead of one query per row.** Two genuine N+1s were
found and fixed on this pattern, both in `apps/api/src/modules/grades/grade-entry-service.ts` — the
core gradebook read/write path:

- **`ensureDraftSubmissions`** looped over every enrolled student missing a draft submission and ran
  one `INSERT ... RETURNING` per student. Replaced with a single
  `INSERT ... SELECT ... FROM unnest($studentIds)` (the same shape
  `attendance-session-service.ts`'s batch record insert already uses), with one audit log for the
  batch — matching the "single audit log for the batch" convention `bulkUpdateGrades` and the
  attendance batch write already established, rather than one audit row per student.
- **`bulkUpdateGrades`** — "the core grade entry operation," up to 100 cells per request — looped
  over every entry and ran one `UPDATE ... WHERE id = ... AND updated_at = ...` (the optimistic
  concurrency check) per cell, plus a follow-up `SELECT` on the first failure. Replaced with one
  `UPDATE ... FROM jsonb_to_recordset(...)` batch update (again mirroring
  `attendance-session-service.ts`'s existing `jsonb_to_recordset` batch-write shape, chosen over
  postgres.js's `sql(array)` VALUES helper because that helper's TypeScript types do not accept a
  `null` score) and a single reconciliation `SELECT` if any row failed to match. The batch's
  first-failure-in-request-order error semantics (404 vs 409, whichever the caller's first bad entry
  is) are preserved exactly; a schema-level duplicate-id rejection
  (`bulkUpdateGradesBodySchema`) was added so a repeated id in one request can never join more than
  one row in the batched `UPDATE`.

Two smaller N+1s were also fixed in `apps/api/src/modules/ai/quiz/materials.ts`
(`loadQuizMaterials`) and `apps/api/src/modules/ai/exam/materials.ts` (`validateExamMaterials`):
each looped over up to `AI_QUIZ_MAX_MATERIALS` (5) material ids doing one existence/ready-status
query per id. Both now do one `WHERE id = ANY($materialIds)` query, then walk the ids in request
order against the result map — preserving "report the first invalid material, in request order"
exactly, at one round trip instead of up to five.

All four fixes are covered by the existing test suites
(`apps/api/src/modules/grades/__tests__/grade-workflow.test.ts`,
`apps/api/src/modules/ai/routes/{quiz,exam,flashcard}-routes.test.ts`), run against a real disposable
PostgreSQL 16 for the grades suite and confirmed passing after the change — including the audit-trail
test that specifically asserts one `insert` audit row per submission, which is what caught that the
batched insert needed to keep targeting its own row's id (not the gradebook) when exactly one draft
is created, matching `bulkUpdateGrades`'s own single-vs-batch audit-target convention.

## Known gaps

- **No staging `pg_stat_statements` sample.** Staging has never been applied to a real AWS account
  from this repo (see `docs/testing/load-test-scenarios.md`'s own finding). The twenty query shapes
  above were selected from real application code and the load-test scenario definitions, not from a
  production statement-frequency sample. Once staging exists and has taken real traffic, the honest
  next step is pulling `pg_stat_statements` ordered by `total_exec_time` and checking whether the
  actual top 20 by cost matches this list — it may not.
- **This pass audited FK-coverage and named-query coverage, not every possible predicate.** A query
  shape not named above (a report or admin screen not exercised by the load-test scenarios or not yet
  written) was not checked. The methodology in this doc — `EXPLAIN` with `enable_seqscan = off`
  against seeded fixtures — is meant to be reused for any new hot query, not treated as a one-time
  audit.
- **`query-plan-budget.test.ts` proves index _existence_, not query cost.** A query can be
  index-served and still be slow at production scale (a wide index scan over millions of rows). Real
  latency numbers require the staging load test this pass could not run.
