# Flashcard decks and spaced repetition (ST-168)

Generates term/definition and Q/A flashcard decks grounded in a school's ingested study materials,
and advances per-student spaced-repetition progress with a pure SM-2 scheduler. Deck generation
rides the same ST-155 entitlement gate and Redis token meter as every other `/api/ai/*` route; the
review endpoints draw no LLM tokens at all. Generation reuses the ST-167 quiz generator's
multi-material chunk loader, the ST-164 gateway's provider, and the ST-162/ST-165 source-block
prompting pattern.

Code: `apps/api/src/modules/ai/flashcards/{schema,prompt,parser,persistence,scheduling}.ts`,
`apps/api/src/modules/ai/routes/flashcard-routes.ts`, `db/migrations/000101_create_flashcard_tables.sql`.

## Endpoints

| Method | Path                                                 | Purpose                                            |
| ------ | ---------------------------------------------------- | -------------------------------------------------- |
| POST   | `/api/ai/students/{studentId}/decks`                 | Generate a flashcard deck from selected materials. |
| GET    | `/api/ai/students/{studentId}/decks/{deckId}/review` | Get a deck's due cards for a study session.        |
| POST   | `/api/ai/students/{studentId}/decks/{deckId}/review` | Submit self-graded ratings; advance SM-2 progress. |

All three are declared in the OpenAPI document (operation ids `generateDeck` / `getDueCards` /
`submitReviews`); this document is the schema and design reference the OpenAPI descriptions point
back to, not a duplicate of them.

### Generate

Request body:

```jsonc
{
  "materialIds": ["0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12"], // 1..5 materials, no duplicates
  "cardCount": 10, // optional, 1..20, default 10
}
```

Response: the deck id, the serving model/tier, provider-reported token usage, and one entry per
card with its faces and citation. Unlike quiz generation there is no hidden answer key: a card's
`back` is its study answer and is returned directly, because flashcards are self-graded.

```jsonc
{
  "deck_id": "…",
  "model": "claude-3-5-haiku-20241022",
  "tier": "small",
  "feature": "flashcards",
  "card_count": 2,
  "usage": { "inputTokens": 612, "outputTokens": 340, "totalTokens": 952 },
  "cards": [
    {
      "id": "…",
      "order": 1,
      "type": "term_definition",
      "front": "Photosynthesis",
      "back": "The process that converts light energy into chemical energy.",
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

### Get due cards

`GET .../decks/{deckId}/review` returns the deck's cards that are due now: never-reviewed cards
(due immediately) plus reviewed cards whose `due_at` has arrived. Cards a student already reviewed
but is not due for yet are intentionally absent -- this is a study session, not a deck listing.

```jsonc
{
  "deck_id": "…",
  "due_count": 1,
  "cards": [
    {
      "id": "…",
      "order": 1,
      "type": "q_a",
      "front": "What releases energy from glucose?",
      "back": "Cellular respiration",
      "citation": { "…": "…" },
      "progress": {
        // null before the first review
        "interval_days": 15,
        "ease_factor": 2.5,
        "repetitions": 3,
        "due_at": "2026-01-14T09:00:00.000Z",
      },
    },
  ],
}
```

### Submit reviews

Request body:

```jsonc
{
  "reviews": [
    { "card_id": "…", "rating": "good" }, // again | hard | good | easy, one entry per card
  ],
}
```

Response: each reviewed card's **new** schedule -- the SM-2 state that now governs when the card
becomes due again:

```jsonc
{
  "deck_id": "…",
  "reviewed_count": 1,
  "results": [
    {
      "card_id": "…",
      "rating": "good",
      "interval_days": 1,
      "ease_factor": 2.5,
      "repetitions": 1,
      "due_at": "2026-01-16T09:00:00.000Z",
    },
  ],
}
```

## The flashcard card schema

One schema (`flashcards/schema.ts`) does three jobs: it is what the generation prompt asks the
model to produce, what every model response is validated against before anything is persisted, and
this table.

| Field       | `term_definition`      | `q_a`                  | Notes                                                                    |
| ----------- | ---------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `type`      | `"term_definition"`    | `"q_a"`                | Discriminant. Schema is `.strict()` -- no cross-type fields.             |
| `front`     | required, 1-500 chars  | required, 1-500 chars  | The term or question. Trimmed non-empty.                                 |
| `back`      | required, 1-1000 chars | required, 1-1000 chars | The definition or answer. Trimmed non-empty.                             |
| `source_id` | required, integer ≥ 1  | required, integer ≥ 1  | The 1-based numbered source this card is grounded on -- Citations below. |

**"Cards cite their chunks" is enforced at two layers**, each catching what the layer before it
cannot:

1. **Zod (`flashcards/schema.ts`)** -- the primary validator: both faces non-empty and bounded,
   the type is one of the two allowed values, `source_id` is a positive integer.
2. **`flashcards/parser.ts`** -- bounds `source_id` against the sources the prompt actually
   contained. A `source_id` the model invented, or copied from a stale context, is caught here even
   though it is schema-valid on its own -- the same bound `quiz/parser.ts` applies to quiz
   citations.

The database re-asserts the shape too (migration 000101): `ck_flashcards_type`, the non-empty
`front`/`back` checks, and the composite FK from `material_chunk_id` to `app.material_chunks`, so a
card whose citation does not resolve to a real chunk can never be stored.

A response that fails validation is never returned to a client and never reaches the database; see
Generation failures below.

## Citations

Every card carries exactly one citation: the single material chunk (`material_chunk_id`, a
composite FK to `app.material_chunks`) it was grounded on -- the same one-citation-per-row posture
quiz questions take. Mechanically this rides the same numbered-source-block prompting
`ask/prompt.ts` and `summary/prompt.ts` use: every loaded chunk becomes source `N`
(`flashcards/prompt.ts`'s `toFlashcardSources`, which reuses the quiz prompt's `toQuizSources`),
wrapped in `<source-{boundary}>...</source-{boundary}>` under a fresh per-request random boundary
token (prompt-injection hardening -- see `docs/rag/ask-ai-streaming-and-prompt-injection.md`), and
the model is told to tag every card with the `source_id` of the one source it used.
`flashcards/parser.ts` bounds that id against the real source count before `flashcards/persistence.ts`
resolves it to a chunk id and inserts the row -- a citation that does not resolve to a real,
retrieved source can never be persisted. The citation is not denormalized into the card row; it is
rendered by joining back to `app.material_chunks` / `app.materials` at read time.

## Generation: materials, prompting, and the model call

Deck generation deliberately **reuses the quiz generator's loader** (`quiz/materials.ts`'s
`loadQuizMaterials`) rather than defining a second one, so decks and quizzes always see the same
input budget: up to `AI_QUIZ_MAX_MATERIALS` (5) materials, each contributing up to
`AI_QUIZ_CHUNK_LIMIT_PER_MATERIAL` (20) chunks, under the shared character budget
(`AI_QUIZ_MAX_INPUT_CHARS`, 30,000 ≈ 7,500 tokens). A material that does not exist, or is not yet
`ingest_status = 'ready'`, fails the whole request (404 / 422) rather than silently generating from
fewer materials than asked.

The provider has no JSON mode or tool use (`llm/provider.ts`'s `generate()` returns plain text), so
the system prompt (`flashcards/prompt.ts`) restates the schema in full -- field names, the two card
types and when to prefer each -- and asks for a bare JSON array, no markdown fence, no commentary.
`flashcards/parser.ts` strips a fenced block if the model sends one anyway, then parses and
validates as described above.

Flashcard generation routes to the **small** tier (`AI_ROUTING_TABLE.flashcards`): a card list is
short, repetitive, structured generation -- the same fast-and-cheap shape summaries get -- not the
cross-question reasoning load that puts quiz generation on the large tier.

### Reservation math

The generate path reuses `AI_LLM_MAX_RESERVE_TOKENS` (24,000) rather than defining its own
reservation. Worst case: the shared quiz input budget (30,000 chars ≈ 7,500 tokens) of input, plus
an output ceiling of `min(4096, cardCount * 180 + 300)` tokens -- at `AI_FLASHCARD_MAX_CARDS`
(20), `20 * 180 + 300 = 3,900`. Total ≈ 11,400 tokens, comfortably inside the existing 24,000
reservation. The review paths make no LLM call and stay on the gate's default hold. See `config.ts`
for the constants this is derived from.

### Generation failures

| Failure                                                         | Response                                            |
| --------------------------------------------------------------- | --------------------------------------------------- |
| LLM plane disabled (`AI_LLM_ENABLED` off)                       | 503 `AI_LLM_DISABLED`                               |
| A material does not exist / is not visible to the school        | 404 `RESOURCE_NOT_FOUND`                            |
| A material is still mid-ingestion, or has no ingested text      | 422 `VALIDATION_FAILED`                             |
| Provider transport failure (timeout, network, 5xx, 429)         | 503 `AI_LLM_UNAVAILABLE`, `Retry-After`             |
| Provider refused the request (non-transient 4xx)                | 503 `AI_LLM_REQUEST_REJECTED`                       |
| Model output fails schema validation or cites an unknown source | 503 `AI_FLASHCARD_GENERATION_FAILED`, `Retry-After` |

Generation failures are **not committed to quota** and there is deliberately no server-side
"regenerate on invalid JSON" retry -- the exact posture and reasoning quiz generation uses (see
`docs/rag/quiz-generation-and-grading.md`).

## Spaced repetition: SM-2

The review endpoints advance each card's schedule with `flashcards/scheduling.ts`'s `scheduleCard`,
a pure function of the card's current progress, the student's rating, and the review instant: same
inputs, same output, every time -- no model call, no randomness, no clock. Its unit tests
(`flashcards/scheduling.test.ts`) are the acceptance criterion "review schedule advances per
algorithm" pinned to concrete numbers.

The algorithm is the classic SM-2 from SuperMemo, with a 4-point rating scale mapped onto SM-2's
0-5 quality:

| Rating  | SM-2 quality | Effect on the schedule                                   |
| ------- | ------------ | -------------------------------------------------------- |
| `again` | 1 (fail)     | repetitions → 0, next interval 1 day, ease factor drops. |
| `hard`  | 3 (pass)     | Interval ladder as below; ease factor drops.             |
| `good`  | 4 (pass)     | Interval ladder as below; ease factor unchanged.         |
| `easy`  | 5 (pass)     | Interval ladder as below; ease factor rises.             |

A pass follows the SM-2 ladder: first review → 1 day, second pass → 6 days, then
`round(interval * ease_factor)` on every later pass. The ease factor updates on every review --
`EF' = EF + (0.1 - (5 - q)(0.08 + (5 - q) * 0.02))` -- floored at 1.3, so `good` leaves it
unchanged, `easy` raises it, and `hard`/`again` lower it. `due_at` is the review instant plus
`interval_days` whole days.

Honest limits, matching the source algorithm: the ratings differ in their ease-factor movement,
not in today's interval (classic SM-2 has no separate hard step); a card scheduled `again` becomes
due tomorrow, it does not leave the deck. Scheduling is SM-2 as published, not a bespoke variant,
so the numbers in the tests can be checked against the reference algorithm.

## Progress tracking: per student, one state row per card

`app.flashcard_reviews` is the one non-append-only table in the feature: one row per
(student, card), the SM-2 state, upserted on every review via `ON CONFLICT
(school_id, student_id, card_id)`. This is the state-row design that keeps both the "due next" read
and the "how many times has this student reviewed this card" question to a single row per card --
`review_count` is the lifetime total, incremented in place on every review. Progress therefore
persists per student across sessions and devices, which is the acceptance criterion "progress
persists per student".

The review routes are explicitly scoped to the requesting student (`loadDeckCards` /
`loadDueCards` filter `student_id`), so a deck generated for a different student in the same school
reads as 404 `AI_FLASHCARD_DECK_NOT_FOUND` -- RLS fences the school, but nothing fences the
student, the same posture quiz grading and Ask AI take. A review naming a `card_id` outside the
deck, or a duplicate review of the same card, answers 422 `VALIDATION_FAILED`. Reviews make **no
LLM call** and are **not quota-metered**; the gate's reservation is settled at `commit(0)`, the
same pattern quiz grading uses. Generation is the only quota-metered surface in the feature.

## Data model

`db/migrations/000101_create_flashcard_tables.sql`:

- **`app.flashcard_decks`** -- one row per generation: school, student, serving model, card count.
  Append-only, like `app.quizzes`.
- **`app.flashcards`** -- one row per card: order, type, front, back, and the citation FK to
  `app.material_chunks`. Append-only; a card is never edited after generation.
- **`app.flashcard_reviews`** -- the mutable per-student-card SM-2 progress described above, with
  CHECK constraints (`interval_days >= 0`, `ease_factor >= 1.3`, `repetitions >= 0`,
  `review_count >= 0`) re-asserting the scheduler's bounds at the storage layer, independent of the
  application.
