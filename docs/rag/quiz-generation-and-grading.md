# Quiz generation and grading (ST-167)

Generates MCQ and short-answer quizzes grounded in a school's ingested study materials, and grades
a submission against the persisted answer key with instant feedback. It rides the same ST-155
entitlement gate and Redis token meter as every other `/api/ai/*` route, and reuses the ST-164 LLM
gateway's provider and the ST-162/ST-165 source-block prompting pattern.

Code: `apps/api/src/modules/ai/quiz/{schema,prompt,materials,parser,persistence,grading}.ts`,
`apps/api/src/modules/ai/routes/quiz-routes.ts`, `db/migrations/000099_create_quiz_tables.sql`.

## Endpoints

| Method | Path                                                  | Purpose                                   |
| ------ | ----------------------------------------------------- | ----------------------------------------- |
| POST   | `/api/ai/students/{studentId}/quizzes`                | Generate a quiz from selected materials.  |
| POST   | `/api/ai/students/{studentId}/quizzes/{quizId}/grade` | Grade a submission with instant feedback. |

Both are declared in the OpenAPI document (operation ids `generateQuiz` / `gradeQuiz`); this
document is the schema and design reference the OpenAPI descriptions point back to, not a
duplicate of them.

### Generate

Request body:

```jsonc
{
  "materialIds": ["0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"], // 1..5 materials, no duplicates
  "questionCount": 5, // optional, 1..15, default 5
  "questionTypes": ["mcq", "short_answer"], // optional, default both
}
```

Response: the quiz id, the serving model/tier, provider-reported token usage, and one entry per
question with its prompt, MCQ options (if any), and citation -- **never the correct answer**. The
only way to learn a question's correct answer is to grade it.

```jsonc
{
  "quiz_id": "…",
  "model": "claude-sonnet-4-20250514",
  "tier": "large",
  "feature": "quiz",
  "question_count": 2,
  "usage": { "inputTokens": 612, "outputTokens": 340, "totalTokens": 952 },
  "questions": [
    {
      "id": "…",
      "order": 1,
      "type": "mcq",
      "prompt": "What converts light energy into chemical energy?",
      "options": [
        { "id": "A", "text": "Photosynthesis" },
        { "id": "B", "text": "Respiration" },
      ],
      "citation": {
        "chunk_id": "…",
        "material_id": "…",
        "material_title": "Biology",
        "page_number": 1,
        "section_title": "Intro",
      },
    },
  ],
}
```

### Grade

Request body:

```jsonc
{
  "answers": [
    { "question_id": "…", "answer": "A" },
    { "question_id": "…", "answer": "Cellular respiration" },
  ],
}
```

A question with no entry in `answers` is graded wrong, not skipped -- `total_questions` always
equals the quiz's question count. Response:

```jsonc
{
  "quiz_id": "…",
  "correct_count": 1,
  "total_questions": 2,
  "percentage": 50,
  "results": [
    {
      "question_id": "…",
      "correct": true,
      "your_answer": "A",
      "correct_answer": "A",
      "citation": { "…": "…" },
    },
  ],
}
```

## The quiz question schema

One schema (`quiz/schema.ts`) does three jobs: it is what the generation prompt asks the model to
produce, what every model response is validated against before anything is persisted, and this
table.

| Field               | mcq                    | short_answer           | Notes                                                                            |
| ------------------- | ---------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `type`              | `"mcq"`                | `"short_answer"`       | Discriminant. Schema is `.strict()` -- no cross-type fields.                     |
| `prompt`            | required, 1-1000 chars | required, 1-1000 chars | Trimmed non-empty.                                                               |
| `source_id`         | required, integer ≥ 1  | required, integer ≥ 1  | The 1-based numbered source this question is grounded on -- see Citations below. |
| `options`           | required, 2-6 entries  | absent                 | Each `{ id, text }`, both trimmed non-empty.                                     |
| `correct_option_id` | required               | absent                 | Must name one of `options[].id`.                                                 |
| `correct_answer`    | absent                 | required, 1-300 chars  | Trimmed non-empty.                                                               |

**"No malformed options" is enforced at three layers**, each catching what the layer before it
cannot:

1. **Zod (`quiz/schema.ts`)** -- the primary validator. Beyond the table above: option ids must be
   unique within a question, option text must be unique (case-insensitive), and
   `correct_option_id` must resolve to a real option. A question that fails any of this is rejected
   in full -- generation is all-or-nothing, not a partial quiz with silently dropped questions.
2. **`quiz/parser.ts`** -- bounds `source_id` against the sources the prompt actually contained
   (see Citations). A `source_id` the model invented, or copied from a stale context, is caught
   here even though it is schema-valid on its own.
3. **The database (migration `000099_create_quiz_tables.sql`)** -- `ck_quiz_questions_shape`
   re-asserts the mcq/short_answer mutual exclusion and the 2-6 option-count bound at the storage
   layer, independent of the application. PostgreSQL CHECK constraints cannot contain subqueries,
   so the deeper invariant -- `correct_option_id` names a real option -- is enforced only at the
   Zod layer, the same place option-id/text uniqueness is enforced.

A response that fails validation at any layer is never returned to a client and never reaches the
database; see Generation failures below.

## Citations

Every question carries exactly one citation: the single material chunk (`material_chunk_id`, a
composite FK to `app.material_chunks`) it was grounded on. This mirrors the "one citation, high
confidence" design choice, not Ask AI's multi-source answers -- a quiz question tests recall of one
fact, so pinning it to one source is more useful than a spread of loosely related ones.

Mechanically, this rides the same numbered-source-block prompting `ask/prompt.ts` and
`summary/prompt.ts` use: every loaded chunk becomes source `N` (`quiz/prompt.ts`'s
`toQuizSources`), wrapped in `<source-{boundary}>...</source-{boundary}>` under a fresh
per-request random boundary token (prompt-injection hardening -- see
`docs/rag/ask-ai-streaming-and-prompt-injection.md`), and the model is told to tag every question
with the `source_id` of the one source it used. `quiz/parser.ts` bounds that id against the real
source count before `quiz/persistence.ts` resolves it to a chunk id and inserts the row -- a
citation that does not resolve to a real, retrieved source can never be persisted.

## Generation: materials, prompting, and the model call

`quiz/materials.ts`'s `loadQuizMaterials` loads every selected material's ingested chunks, in
request order, the same contiguous-prefix-until-budget approach `summary/materials.ts` uses for
one material, extended across up to `AI_QUIZ_MAX_MATERIALS` (5): each material contributes up to
`AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL` (20) chunks, and the running character budget
(`AI_QUIZ_MAX_INPUT_CHARS`, 30,000 ≈ 7,500 tokens) is shared across all of them. A material that
does not exist, or is not yet `ingest_status = 'ready'`, fails the whole request (404 / 422) rather
than silently generating from fewer materials than asked.

The provider has no JSON mode or tool use (`llm/provider.ts`'s `generate()` returns plain text), so
the system prompt (`quiz/prompt.ts`) restates the schema in full -- field names, allowed types, the
MCQ option-count and uniqueness rules -- and asks for a bare JSON array, no markdown fence, no
commentary. `quiz/parser.ts` strips a fenced block if the model sends one anyway, then parses and
validates as described above.

Quiz generation always routes to the **large** tier (`AI_ROUTING_TABLE.quiz`, see
`docs/rag/llm-gateway-and-model-routing.md`): keeping several questions, their citations, and their
answer keys internally consistent across a mixed question set is the same reasoning load as exam
explanations, not the short, repetitive shape summary/flashcards get.

### Reservation math

The generate path reuses `AI_LLM_MAX_RESERVE_TOKENS` (24,000) rather than defining its own
reservation. Worst case: `AI_QUIZ_MAX_INPUT_CHARS` (30,000 chars ≈ 7,500 tokens) of input, plus an
output ceiling of `min(4096, questionCount * 220 + 300)` tokens -- at
`AI_QUIZ_MAX_QUESTIONS` (15), `15 * 220 + 300 = 3,600`. Total ≈ 11,100 tokens, comfortably inside
the existing 24,000 reservation. See `config.ts` for the constants this is derived from.

### Generation failures

| Failure                                                         | Response                                       |
| --------------------------------------------------------------- | ---------------------------------------------- |
| LLM plane disabled (`AI_LLM_ENABLED` off)                       | 503 `AI_LLM_DISABLED`                          |
| A material does not exist / is not visible to the school        | 404 `RESOURCE_NOT_FOUND`                       |
| A material is still mid-ingestion, or has no ingested text      | 422 `VALIDATION_FAILED`                        |
| Provider transport failure (timeout, network, 5xx, 429)         | 503 `AI_LLM_UNAVAILABLE`, `Retry-After`        |
| Provider refused the request (non-transient 4xx)                | 503 `AI_LLM_REQUEST_REJECTED`                  |
| Model output fails schema validation or cites an unknown source | 503 `AI_QUIZ_GENERATION_FAILED`, `Retry-After` |

**There is deliberately no server-side "regenerate on invalid JSON" retry.** A schema-validation
failure is treated the same as a transport failure: 503, `Retry-After`, and -- because the response
was never usable -- **not committed to quota**, the same posture a transport failure already gets
(the ST-155 gate auto-releases an unsettled reservation). This is a known, accepted trade-off: the
provider may have billed real tokens for a response that failed validation, and those are not
charged to the school's quota. Adding a partial-commit-then-throw path would buy back that
precision at the cost of a code path with no precedent anywhere else in the gateway; a well-formed
prompt makes this rare in practice, and retrying is a client action, not a hidden server-side loop
that would double the worst-case latency and cost of every generation.

## Grading: deterministic, not semantic

`quiz/grading.ts`'s `gradeQuiz` is a pure function of the persisted answer key and the submitted
answers -- no model call, no randomness, no clock, so identical input always produces an identical
score:

- **MCQ**: exact match against `correct_option_id` (trimmed, case-sensitive).
- **Short answer**: normalized string equality -- trim, casefold, collapse internal whitespace.
  This is deterministic and honest about its limits, not a semantic judgement: a correct answer
  phrased differently, or a synonym, is marked wrong. If semantic short-answer grading is ever
  wanted, it is a different, LLM-backed feature with its own non-determinism and cost -- not a
  variation on this endpoint.
- A question with no submitted answer is graded wrong, not omitted, so a client can always render
  every question's result.
- A duplicate `question_id` in one submission uses the later entry ("last write wins").

Grading makes **no LLM call** and is **not quota-metered** -- the ST-167 acceptance criterion
("generation quota-metered") scopes token spend to generation only. The reservation the ST-155 gate
takes for the request is settled at `commit(0)`, the same pattern the summarizer's cache-hit path
uses. Grading still runs under the gate (school active / AI add-on active / quota available), so
it is still an entitled AI surface, just an unbilled one.

A quiz is looked up by id **and** filtered to the requesting student
(`quiz/persistence.ts`'s `loadQuizForGrading`): RLS already fences the school, but nothing fences
the student, so a quiz generated for a different student in the same school reads as 404
`AI_QUIZ_NOT_FOUND`, the same posture Ask AI's `AI_CONVERSATION_NOT_FOUND` takes for a foreign
conversation. An answer naming a `question_id` outside the quiz answers 422 `VALIDATION_FAILED`.

## Data model

`db/migrations/000099_create_quiz_tables.sql`:

- **`app.quizzes`** -- one row per generation: school, student, serving model, question count.
  Append-only, like `app.ai_messages`.
- **`app.quiz_questions`** -- one row per question: order, type, prompt, MCQ options / correct
  answer (mutually exclusive, `ck_quiz_questions_shape`), and the citation FK to
  `app.material_chunks`. Not denormalized -- no material title or page number copied here, the
  same normalization rule `app.ai_message_citations` follows; a citation is rendered by joining
  back to `app.material_chunks` / `app.materials` at read time.

The answer key (`correct_option_id`, `correct_answer`) lives only in `app.quiz_questions`.
`quiz/persistence.ts`'s `PersistedQuizQuestion` -- what the generation response is built from --
structurally cannot carry it; only `loadQuizForGrading` reads those two columns, and only the
grading route calls it.
