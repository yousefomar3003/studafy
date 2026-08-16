# Key-concept extraction (ST-169)

Extracts a study material's key concepts -- each with a one-line explanation and the source chunks
it is grounded on -- from a single material's ingested text. Concept extraction rides the same
ST-155 entitlement gate and Redis token meter as every other `/api/ai/*` route, reuses the
summarizer's single-material chunk loader (`summary/materials.ts`) and its input budgets, the
ST-164 gateway's provider, and the ST-162/ST-165 numbered-source-block prompting pattern. The
output is deterministic per material for a given student, so it is cached in Redis keyed by the
same chunk-set fingerprint summaries use.

Code: `apps/api/src/modules/ai/concepts/{schema,parser,merge,grounding,prompt,cache}.ts`,
`apps/api/src/modules/ai/routes/concepts-routes.ts`.

## Endpoint

| Method | Path                                    | Purpose                                                |
| ------ | --------------------------------------- | ------------------------------------------------------ |
| POST   | `/api/ai/students/{studentId}/concepts` | Extract the deduplicated key concepts of one material. |

The route is declared in the OpenAPI document (operation id `extractConcepts`); this document is
the schema and design reference the OpenAPI descriptions point back to, not a duplicate of them.

### Generate

Request body:

```jsonc
{
  "materialId": "0f5c6b64-2b3f-4c8e-9a1e-6f3e5f0a9b12", // one material, must be visible and fully ingested
}
```

Response: the material's deduplicated concepts in first-mention order, the serving model/tier,
provider-reported token usage, and whether the response came from the cache:

```jsonc
{
  "concepts": [
    {
      "name": "Photosynthesis",
      "explanation": "The process that converts light energy into chemical energy.",
      "sources": [
        {
          "chunk_id": "…", // app.material_chunks.id
          "chunk_index": 0, // ordinal within the material, 0-based like the table
          "page_number": 1,
          "section_title": "Intro",
          "order": 1, // 1-based source position in the prompt
        },
      ],
    },
  ],
  "model": "claude-3-5-haiku-20241022",
  "tier": "small",
  "feature": "concepts",
  "cached": false,
  "usage": { "inputTokens": 612, "outputTokens": 340, "totalTokens": 952 },
}
```

## The concept schema

One schema (`concepts/schema.ts`) does three jobs: it is what the generation prompt asks the model
to produce, what `concepts/parser.ts` validates every model response against, and this table.

| Field         | Type                      | Notes                                                                 |
| ------------- | ------------------------- | --------------------------------------------------------------------- |
| `name`        | required, 1-120 chars     | The key term, as the sources name it. Trimmed non-empty, single line. |
| `explanation` | required, 1-300 chars     | A one-line, faithful explanation. Trimmed non-empty, single line.     |
| `source_ids`  | required, non-empty array | Every source (1-based position in the prompt) that mentions it.       |

The schema is `.strict()` -- no extra fields survive -- and the full response is a **non-empty**
array. "Single line" is enforced by zod: `\r` or `\n` anywhere in `name` or `explanation` fails
validation, so the model cannot smuggle a multi-line payload through the one-line contract.

Two layers validate citations, each catching what the layer before it cannot:

1. **Zod (`concepts/schema.ts`)** -- the primary validator: names and explanations bounded and
   single-line, `source_ids` a non-empty array of integers ≥ 1.
2. **`concepts/parser.ts`** -- bounds every `source_id` against the sources the prompt actually
   contained. A source the model invented, or copied from a stale context, is caught here even
   though it is schema-valid on its own -- the same bound `quiz/parser.ts` applies to quiz
   citations.
3. **`concepts/grounding.ts`** -- the corpus check, below.

A response that fails any layer is never returned to a client; see Generation failures.

## Grounding: "concepts present in corpus"

The acceptance criterion "concepts present in corpus" is enforced deterministically, after the
model output has been parsed and merged: a concept whose **name does not literally appear in any
chunk text it cites** is a hallucination -- the model invented a topic and pointed at sources that
do not support it. `ungroundedConcepts` rejects the whole generation on the first such concept
rather than silently dropping it, the same posture `quiz/parser.ts` takes for a bad citation: one
ungrounded concept means the output cannot be trusted.

This is deliberately a **presence check, not a semantic one**: `name` is folded (lowercased, runs
of whitespace collapsed to a single space) and looked up as a substring of the equally-folded chunk
text, so a line break inside a chunk cannot hide a concept the source does state. Whether the
explanation is faithful is the model's job; the validator only guarantees the concept the student
is handed actually exists in the material it is attributed to.

## Duplicate merging: "duplicates merged"

The model is asked to merge name-equivalent concepts itself, but the acceptance criterion cannot
rest on a model's word -- the JSON that already passed the parser is re-checked deterministically
by `concepts/merge.ts`: two concepts whose names are equal once normalized (trimmed, lowercased,
whitespace collapsed) are one concept. The first occurrence keeps its name and explanation (model
order is treated as priority), and the sources of every duplicate are unioned -- deduplicated and
sorted ascending -- so a concept split across chunks carries every anchor that supports it, which
is exactly what "each tied to source anchors" wants the client to render. The result is stable:
same input in, same output, every time.

## Generation: materials, prompting, and the model call

Concept extraction deliberately **reuses the summarizer's loader** (`summary/materials.ts`'s
`loadSummaryMaterial`) rather than defining a second one, so concepts and summaries always see the
same input budget: one material, up to `AI_SUMMARY_CHUNK_LIMIT` (50) chunks, under the shared
character budget `AI_SUMMARY_MAX_INPUT_CHARS` (40,000 ≈ 10,000 input tokens). A material that does
not exist, or is not yet `ingest_status = 'ready'`, fails the whole request (404 / 422) rather
than silently generating from nothing.

The provider has no JSON mode or tool use (`llm/provider.ts`'s `generate()` returns plain text), so
the system prompt (`concepts/prompt.ts`) restates the schema in full -- field names, the single-line
and source-count constraints -- and asks for a bare JSON array, no markdown fence, no commentary.
`concepts/parser.ts` strips a fenced block if the model sends one anyway, then parses and validates
as described above. The prompt reuses the same numbered-source-block assembly (`sourceBlock`, a fresh
per-request random boundary token) the ask/summary routes use -- prompt-injection hardening, see
`docs/rag/ask-ai-streaming-and-prompt-injection.md`.

Concept extraction routes to the **small** tier (`AI_ROUTING_TABLE.concepts`): a concept list is
short, repetitive, structured generation -- the same fast-and-cheap shape summaries and flashcards
get -- not the cross-question reasoning load that puts quiz generation on the large tier.

### Reservation math

The route reuses `AI_LLM_MAX_RESERVE_TOKENS` (24,000) rather than defining its own reservation.
Worst case: the summary input budget (40,000 chars ≈ 10,000 tokens) of input, plus an output
ceiling of `min(4096, 30 * 150 + 300)` tokens -- at `AI_CONCEPTS_MAX_CONCEPTS` (30),
`30 * 150 + 300 = 4,800`, capped at 4,096. Total ≈ 14,100 tokens, comfortably inside the existing
24,000 reservation. See `config.ts` for the constants this is derived from.

### Generation failures

| Failure                                                                                          | Response                                           |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| LLM plane disabled (`AI_LLM_ENABLED` off)                                                        | 503 `AI_LLM_DISABLED`                              |
| A material does not exist / is not visible to the school                                         | 404 `RESOURCE_NOT_FOUND`                           |
| A material is still mid-ingestion, or has no ingested text                                       | 422 `VALIDATION_FAILED`                            |
| Provider transport failure (timeout, network, 5xx, 429)                                          | 503 `AI_LLM_UNAVAILABLE`, `Retry-After`            |
| Provider refused the request (non-transient 4xx)                                                 | 503 `AI_LLM_REQUEST_REJECTED`                      |
| Output fails schema validation, cites an unknown source, or names a concept that fails grounding | 503 `AI_CONCEPTS_GENERATION_FAILED`, `Retry-After` |

Generation failures are **not committed to quota** and there is deliberately no server-side
"regenerate on invalid JSON" retry -- the exact posture and reasoning quiz generation uses (see
`docs/rag/quiz-generation-and-grading.md`).

## Caching: "cached per material version"

Extraction is deterministic per (student, material), so `concepts/cache.ts` mirrors the summary
cache: a Redis key `aiconc:{studentId}:{materialId}:{fingerprint}`, where the fingerprint is the
same chunk-set fingerprint summaries use (`summary/cache.ts`'s `summaryFingerprint`) -- the two
features key on exactly the same "which text was served" signal, so a material re-ingested with
different content gets a different fingerprint and a fresh concept list. A repeat request is served
from cache with a zero-token commit against quota; only a miss spends tokens. The cache is an
accelerator -- a miss, eviction, or Redis error all degrade to regenerating, and a corrupt cached
payload is treated as a miss rather than an error.
