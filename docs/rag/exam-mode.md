# Exam mode (ST-171)

Timed mock exams over a chosen scope: mixed MCQ/short-answer items generated from the corpus, a
server-enforced timer, deterministic scoring, and a per-topic weakness report citing study
materials. Depends on ST-167 (quiz generation), whose grounded-generation pattern (Zod schema →
parser → citation bounds → Postgres CHECK constraint) this reuses structurally. Unlike every other
`/api/ai/*` surface, item-bank generation does not run on the request path — it is heavy (up to 40
items across up to 8 materials), so it runs in a BullMQ worker with its own progress status, per the
ST-171 acceptance criteria.

Code: `apps/api/src/modules/ai/exam/{grading,materials,persistence,report}.ts`,
`apps/api/src/modules/ai/routes/exam-routes.ts`, `apps/workers/src/queues/exam-generation/*`,
`db/migrations/000102_create_exam_tables.sql`.

## Naming

`app.exams` and `app.exam_results` already exist (migration `000011`) as the teacher-administered,
scheduled academic exam record — a different owner, different columns, different meaning entirely.
The AI-generated mock-exam tables are named `app.exam_sessions` / `app.exam_items` /
`app.exam_item_options` / `app.exam_item_answers` to avoid that collision. The route factory and its
barrel export are `aiExamRoutes` / `aiExamRoutes`, not `examRoutes` — `apps/api/src/app.ts` already
imports an unrelated `examRoutes` from `./modules/academics` for the real thing.

## Endpoints

| Method | Path                                                 | Purpose                                                                |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/api/ai/students/{studentId}/exams`                 | Validate scope, create the session, enqueue generation. 202.           |
| GET    | `/api/ai/students/{studentId}/exams/{examId}`        | Poll status; content depends on `status`.                              |
| POST   | `/api/ai/students/{studentId}/exams/{examId}/start`  | `ready -> in_progress`: start the server-side timer, reveal items.     |
| POST   | `/api/ai/students/{studentId}/exams/{examId}/submit` | `in_progress -> submitted`: score, persist answers, return the report. |

All four are declared in the OpenAPI document (operation ids `createExam` / `getExam` / `startExam`
/ `submitExam`); this document is the schema and design reference the OpenAPI descriptions point
back to, not a duplicate of them.

### Create

```jsonc
{
  "materialIds": ["0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"], // 1..8 materials, no duplicates
  "questionCount": 20, // optional, 5..40, default 20
  "questionTypes": ["mcq", "short_answer"], // optional, default both
  "durationMinutes": 30, // optional, 5..180, default 30
}
```

Response (202): one flat, evolving resource shape — see "GET" below. `status` is `"generating"`;
`items` and `report` are both `null`.

### GET — one resource, evolving by status

The same "one resource, one shape, evolving representation" convention
`finance/reports/routes.ts`'s export-job status endpoint uses. `GET` never mutates the session, so
polling can never start the timer.

```jsonc
{
  "id": "…",
  "status": "generating" | "ready" | "in_progress" | "submitted" | "failed",
  "model": "claude-sonnet-4-20250514",
  "tier": "large",
  "feature": "exam",
  "question_count": 20,
  "duration_minutes": 30,
  "created_at": "…", "started_at": null, "expires_at": null, "submitted_at": null,
  "failure_reason": null,
  "usage": { "input_tokens": 12000, "output_tokens": 3800 }, // null until generation succeeds
  "items": null,   // populated only while in_progress
  "report": null,  // populated only once submitted
  "polling_url": "/api/ai/students/{studentId}/exams/{examId}",
}
```

`items` is deliberately **never** populated at `ready` — nothing is visible before the student
commits to starting the clock via `start`. Once `in_progress`, `items` carries every item's prompt,
options, and citation, but never the answer key. Once `submitted`, `report` carries the per-topic
result (see below) and `items` reverts to `null` — a submitted exam is reviewed by topic, not
re-rendered as a raw item list.

### Start

No body. Transitions `ready -> in_progress`, stamping `started_at` / `expires_at` from the
**server's** clock — the request carries no duration, because the client cannot set or extend either
timestamp through any field it controls. Response is the same resource shape as `GET`, with `items`
populated. 409 `AI_EXAM_INVALID_STATE` from any status other than `ready`.

### Submit

```jsonc
{
  "answers": [
    { "item_id": "…", "answer": "A" },
    { "item_id": "…", "answer": "Cellular respiration" },
  ],
}
```

An item with no entry in `answers` is graded wrong, not skipped. Refused with 409 `AI_EXAM_EXPIRED`
once `now() > expires_at` — **the server-side timer enforcement the acceptance criteria ask for**.
Response is the same resource shape, `status: "submitted"`, `report` populated.

## The exam item schema and the grounded validator

`apps/workers/src/queues/exam-generation/schema.ts` is, deliberately, the same shape as
`apps/api/src/modules/ai/quiz/schema.ts` — the item-bank validator ST-171 asks for is the same
three-layer pattern quiz generation already established, reimplemented in the worker (not imported)
because `apps/workers` cannot depend on `apps/api/src` across the process boundary:

1. **Zod** (`schema.ts`) — the primary validator. mcq: 2-6 options, unique ids, unique
   (case-insensitive) text, `correct_option_id` resolving to a real option. short_answer: a single
   non-empty `correct_answer`. An item failing any of this is rejected in full — generation is
   all-or-nothing.
2. **`parser.ts`** — bounds `source_id` against the sources the prompt actually contained. A
   `source_id` the model invented is caught here even though it is schema-valid on its own.
3. **The database** (migration `000102`) — `ck_exam_items_shape` re-asserts the mcq/short_answer
   mutual exclusion at the storage layer, mirroring `ck_quiz_questions_shape`.

A response failing any layer never reaches persistence — the generation job is marked terminal
(session `failed`) rather than retried; see "Generation failures" below.

## Citations

Every item carries exactly one citation — the single material chunk (`material_chunk_id`) it was
grounded on — the same "one citation, high confidence" design quiz uses. Mechanically, this rides the
same numbered-source-block prompting `ask/prompt.ts` / `quiz/prompt.ts` use, reimplemented locally in
`apps/workers/src/queues/exam-generation/prompt.ts` for the same cross-process reason the schema is:
every loaded chunk becomes source `N`, wrapped in `<source-{boundary}>...</source-{boundary}>` under
a fresh per-job random boundary token, and the model tags every item with the `source_id` of the one
source it used.

## Generation: the worker

`apps/workers/src/queues/exam-generation/` consumes `QUEUE_NAMES.AI_EXAM_GENERATION` (job
`JOB_NAMES.GENERATE_EXAM`), one job per `app.exam_sessions` row:

1. **Claim** (`persistence.ts`'s `claimExamSession`) — lock the row `FOR UPDATE`, verify it is still
   `generating`. A duplicate or requeued job whose session already settled is an idempotent no-op —
   generation never runs twice for one session.
2. **Load materials** (`materials.ts`) — the same contiguous-prefix-until-budget chunk loader
   `quiz/materials.ts` uses, reimplemented locally (bound constants shared via
   `@studafy/constants`'s `ai-exam.ts`, since those are plain numbers both the API's request
   validation and the worker's loader must agree on). A material gone missing or un-ingested here is
   a rare TOCTOU race — the API's create route already validated existence/readiness synchronously —
   and is terminal immediately, not retried.
3. **Call the LLM** (`anthropic-client.ts`) — a small, worker-local, non-streaming Anthropic client.
   Not a shared package: see "Why the worker has its own LLM client" below.
4. **Parse and validate** (`schema.ts` / `parser.ts`) — the three-layer validator above. A
   validation failure is terminal immediately, the same "no server-side regenerate-on-invalid-JSON
   retry" posture ST-167's doc documents for its own synchronous path.
5. **Persist** (`persistence.ts`'s `persistExamItemsAndMarkReady`) — insert `exam_items` /
   `exam_item_options`, flip the session to `ready`, store the provider's reported token usage.
   Atomic: a crash between inserting items and flipping status cannot leave orphaned items or a
   `ready` session with none.

### Why the worker has its own LLM client

`apps/workers` has never made a chat-completion call before (its one existing AI queue,
`ai-ingestion`, only does OCR/chunking/embeddings). The natural-looking fix — extract
`apps/api/src/modules/ai/llm/provider.ts` into a shared package both apps import — was deliberately
not done. `apps/workers/src/log.ts`'s `WorkerLogger` already answered this exact "does a second
service need apps/api's infra" question for logging: its header comment explains that extracting a
shared package is "a ticket rather than a side effect" of the feature that first needed it, and
instead ships a small, wire-compatible parallel implementation. `anthropic-client.ts` follows that
precedent: non-streaming only (the worker never streams), no circuit breaker (BullMQ's own per-job
`attempts` + exponential backoff — `EXAM_GENERATION_JOB_OPTIONS` — is the retry unit for a queued
job, the same way every other worker queue in this codebase already relies on job-level retry rather
than an in-process breaker).

Retry policy inside the worker (`worker.ts`): a **transient** LLM failure (timeout, network, 5xx,
429 — `isTransientAnthropicFailure`) rethrows so BullMQ retries, unless this is already the final
attempt (`isFinalAttempt`, imported from `apps/workers/src/queues/reports/report-runner.ts` — the
exact "retry transient, fail permanent on the last attempt" idiom the reports queue already
established), in which case the session is marked `failed` instead. A **non-transient** failure (a
4xx verdict from a healthy provider, or a schema/grounding validation failure) is terminal
immediately regardless of attempt count — retrying a deterministic failure wastes attempts and
delays the client's feedback.

## Timer enforcement

Server-side, across two mutating actions, not embedded in generation:

- `POST .../start` stamps `started_at = clock_timestamp()` and
  `expires_at = clock_timestamp() + make_interval(mins => duration_minutes)` in one guarded `UPDATE
... WHERE status = 'ready'` — atomic, so a double `start` call cannot restart the clock.
- `POST .../submit` refuses with 409 `AI_EXAM_EXPIRED` once `now() > expires_at`, checked against the
  loaded session row before any grading happens.
- `GET` never mutates state, so refreshing a status page can never start the clock, and there is no
  stored `expired` status — an abandoned, never-submitted session just stays `in_progress` forever,
  the same posture `app.assignment_submissions` takes toward a draft never turned in. Expiry is a
  read-time/submit-time comparison, the same reasoning `app.ai_messages.expires_at` uses (migration
  `000021`) for a marker rather than a state machine.

## Quota

`POST .../exams` commits `AI_EXAM_MAX_RESERVE_TOKENS` **in full, at create time**, rather than
metering the worker's actual token usage after the fact the way every synchronous AI surface does.

The Redis-scripted quota meter (`ai/usage/meter.ts`) reserves and commits within one request/response
cycle. An async worker job running in a different process cannot settle that same reservation without
carrying the meter (its Lua scripts, its Redis connection) across the process boundary — the same
class of cross-app sharing this document's generation section explains was deliberately not built for
this ticket. So the create route reserves and commits the ceiling synchronously, before returning
202: **a failed generation is not refunded, and a cheap generation is not charged less than its worst
case.** This is a disclosed trade-off, not an oversight — see `apps/api/src/modules/ai/config.ts`'s
`AI_EXAM_MAX_RESERVE_TOKENS` comment. `GET` / `start` / `submit` make no LLM call and settle their own
(default-size) reservation at zero tokens, the same posture quiz's grading endpoint takes. The
worker's reported `input_tokens` / `output_tokens` are still recorded on the session row and surfaced
in `usage` — informational, not the billing source of truth.

## Scoring: deterministic, not semantic

`apps/api/src/modules/ai/exam/grading.ts`'s `gradeExam` is a pure function of the persisted answer
key and the submitted answers — the same algorithm `quiz/grading.ts`'s `gradeQuiz` uses (MCQ exact
match, short-answer normalized-string equality, unanswered graded wrong, last-write-wins on a
duplicate item id), reimplemented with exam-appropriate naming rather than imported, since an exam
item and a quiz question are the same shape by coincidence, not by a real domain relationship.

Unlike quiz grading (an unpersisted, repeatable pure function — an exam has no re-grade endpoint),
`submitExamAnswers` writes one `app.exam_item_answers` row per item, so the per-topic report is
re-fetchable by a later `GET` rather than a one-shot response nobody can see again.

## Per-topic report

No report is denormalized or persisted as a blob — consistent with the codebase's stated
normalization rule (the quiz migration's own comment: "a citation is rendered by joining back to
`app.material_chunks` / `app.materials` at read time"). `apps/api/src/modules/ai/exam/report.ts`'s
`loadExamReport` computes it fresh every time it's asked for — once by `submit` to build its
response, and again by any later `GET` of a `submitted` session — by joining
`exam_items -> exam_item_answers -> material_chunks -> materials`, grouped by material:

```jsonc
{
  "correct_count": 14,
  "total_items": 20,
  "percentage": 70,
  "topics": [
    {
      "material_id": "…",
      "material_title": "Cell Biology",
      "correct": 3,
      "total": 8,
      "percentage": 37,
      "weak": true, // percentage <= AI_EXAM_WEAK_TOPIC_THRESHOLD (60)
      "study_references": [{ "chunk_id": "…", "page_number": 4, "section_title": "Mitochondria" }],
    },
  ],
}
```

"Topic" is the material an item was grounded on — coarser than the chunk (a section within a
material is not a stable, nameable unit) and finer than "the exam" (which would not tell a student
where to go re-study). `study_references` on a topic lists the citations of that topic's
**incorrect** items only, deduplicated by chunk — the material to go re-read, not everything that
was asked.

## Data model

`db/migrations/000102_create_exam_tables.sql`:

- **`app.exam_sessions`** — one row per generation request, created `generating` **before** the
  worker has produced anything (unlike `app.quizzes`, written only after a successful synchronous
  generation). `ck_exam_sessions_lifecycle` pairs `status` with which of
  `started_at`/`expires_at`/`submitted_at`/`correct_count`/`input_tokens`/`output_tokens`/
  `failure_reason` must be null/non-null in each of the five states, the same discipline
  `ck_exam_results_lifecycle` / `ck_assignment_submissions_lifecycle` (migration `000011`) use.
- **`app.exam_items`** / **`app.exam_item_options`** — identical shape and normalization rationale to
  `app.quiz_questions` / `app.quiz_question_options` (migration `000099`).
- **`app.exam_item_answers`** — one row per item, written once at submit: `submitted_answer` (null
  when left blank) and `is_correct`. Has no quiz counterpart, because quiz grading persists nothing.

## Generation failures

| Failure                                                      | Session outcome                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Generation queue / Redis not configured at create time       | 503 `AI_EXAM_GENERATION_UNAVAILABLE` (synchronous, before a session is created)    |
| `queue.add()` itself fails after the session row was created | Session marked `failed`; create still answers 503 `AI_EXAM_GENERATION_UNAVAILABLE` |
| A requested material does not exist / is not visible         | 404 `RESOURCE_NOT_FOUND` (synchronous, at create)                                  |
| A material is still mid-ingestion                            | 422 `VALIDATION_FAILED` (synchronous, at create)                                   |
| Worker: material vanished/un-ingested since create (TOCTOU)  | Session `failed`, `failure_reason` names the material                              |
| Worker: transient LLM failure, attempts remaining            | BullMQ retries the job (`EXAM_GENERATION_JOB_OPTIONS`)                             |
| Worker: transient LLM failure, final attempt                 | Session `failed`                                                                   |
| Worker: non-transient LLM failure (4xx)                      | Session `failed` immediately, no retry                                             |
| Worker: model output fails schema/grounding validation       | Session `failed` immediately, no retry                                             |

A `failed` session's `failure_reason` is surfaced on `GET`, never as an HTTP error — there is no
request in flight to fail once generation has moved to the worker.

## Other lifecycle failures

| Failure                                                   | Response                    |
| --------------------------------------------------------- | --------------------------- |
| Session does not exist, or belongs to a different student | 404 `AI_EXAM_NOT_FOUND`     |
| `start` called from any status other than `ready`         | 409 `AI_EXAM_INVALID_STATE` |
| `submit` called from any status other than `in_progress`  | 409 `AI_EXAM_INVALID_STATE` |
| `submit` called after `expires_at`                        | 409 `AI_EXAM_EXPIRED`       |
| `submit` names an `item_id` outside the session           | 422 `VALIDATION_FAILED`     |
