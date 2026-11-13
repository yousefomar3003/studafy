# NFR-11 RAG groundedness, citation accuracy, and refusal correctness

Formal document for the NFR ID that existed only as a code comment before this pack
(`grep -rn "NFR-11"` previously returned three test-file comments and zero `docs/` hits — this
file closes that gap). Written the same way `NFR-05_cross_tenant_isolation.md` documents its
probe: what the gate checks, why the thresholds are set where they are, how to run it, and what to
do on a failure.

## What this protects against

Studafy's AI ask feature (`POST /api/ai/students/{studentId}/ask`) answers from retrieved course
material via hybrid search + grounded prompting (`apps/api/src/modules/ai/ask/`,
`apps/api/src/modules/ai/retrieval/search.ts`). The failure modes this NFR exists to catch:

- The model answers from something other than the retrieved material (hallucination).
- The model cites a source that doesn't actually support the cited sentence, or invents a
  citation number that doesn't exist.
- The grounding gate refuses to answer when it should, or answers when it should refuse (a
  false-negative refusal is a hallucination that got past the safety net; a false-positive refusal
  is a real, answerable question the student doesn't get help with).
- Genuinely relevant material isn't retrieved at all, so there was nothing to ground an answer in.

## The harness

`apps/api/tests/ai-eval/harness.test.ts` runs a 15-case golden set
(`apps/api/tests/ai-eval/golden-set.ts`) through the **real production decision layer** —
`assessGrounding` and citation resolution from `apps/api/src/modules/ai/ask/refusal.ts` and
`.../prompt.ts` — not a reimplementation. It is component-level: no HTTP, no database, no LLM call,
which is what makes it deterministic and fast enough to run on every test invocation rather than
being gated behind infrastructure that (per `docs/testing/load-test-scenarios.md`) doesn't exist
in this repo yet anyway.

Four pure scoring functions (`apps/api/tests/ai-eval/scoring.ts`), each 0..1:

| Metric              | Question it answers                                                          | CI threshold                                     |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| Groundedness        | Can every sentence in the answer be traced to at least one retrieved source? | ≥ 0.95                                           |
| Citation accuracy   | Do the model's `[N]` citation tokens resolve to a real, relevant source?     | ≥ 0.90                                           |
| Refusal correctness | Does the grounding verdict match the case's expected refuse/answer outcome?  | ≥ 0.95                                           |
| Retrieval recall    | Are the genuinely relevant chunks present in the top-k hits?                 | (scored, not separately thresholded — see below) |

The golden set's 15 cases are split deliberately: 8 grounded-answer cases, 4 refusal cases (hits
below the grounding bar, or missing the keyword leg of hybrid search), 2 citation edge cases
(invented citation id, out-of-range id), 1 retrieval edge case (a relevant chunk that falls outside
top-k). `golden-set.ts`'s own header asks that every future case model something the production
pipeline actually encounters, not a synthetic case that never happens.

## Run it

```bash
cd apps/api
bun run test:ai-eval
```

## Last real run — 2026-09-23

Run against this repo's current `main`-adjacent state as part of compiling this evidence pack (see
[`nfr-verification-evidence-pack.md`](../runbooks/launch/nfr-verification-evidence-pack.md)):

```
6 pass, 0 fail, 127 expect() calls. Ran 6 tests across 1 file. [216.00ms]

Case                                Ground  Cite  Refuse  Recall
grounded-photosynthesis              1.00   1.00   1.00   1.00
grounded-mitosis                     1.00   1.00   1.00   1.00
grounded-newton                      1.00   1.00   1.00   1.00
grounded-emancipation                1.00   1.00   1.00   1.00
grounded-molarity                    1.00   1.00   1.00   1.00
grounded-water-cycle                 1.00   1.00   1.00   1.00
grounded-electrolysis                1.00   1.00   1.00   1.00
grounded-plate-tectonics             1.00   1.00   1.00   1.00
refusal-semantic-only                1.00   1.00   1.00   1.00
refusal-below-threshold              1.00   1.00   1.00   1.00
refusal-weak-hits                    1.00   1.00   1.00   1.00
refusal-tangential                   1.00   1.00   1.00   1.00
citation-out-of-range                1.00   0.50   1.00   1.00
citation-invented-id                 1.00   0.50   1.00   1.00
retrieval-partial-recall             1.00   0.67   1.00   1.00
AVERAGE                              1.00   0.91   1.00   1.00
```

**Pass**, all three thresholds cleared (groundedness 1.00 ≥ 0.95, citation accuracy 0.91 ≥ 0.90,
refusal correctness 1.00 ≥ 0.95). Citation accuracy's margin is the thinnest of the three (0.91
against a 0.90 floor) — worth watching, not currently a failure. The three lowest-scoring cases
(`citation-out-of-range`, `citation-invented-id`, `retrieval-partial-recall`) are exactly the cases
the golden set built on purpose to exercise citation and recall edge cases (§ "The harness" above)
— a low per-case score there is the gate working, not a defect.

## Live-retrieval run — 2026-11-03 (QA-15, ADR-020)

The component run above does **not** measure retrieval. Its hits are hand-written, and their RRF
scores (0.042–0.06) cannot occur: two fused legs score at most `2/(60+1) ≈ 0.033`, and one leg at
most `1/61 ≈ 0.0164`. QA-15 asks for numbers against the configuration production actually runs,
so `apps/api/tests/ai-eval/retrieval.integration.test.ts` adds a run on live PostgreSQL:

- Every distinct chunk in the golden set (33) is seeded into one tenant material. Every case
  therefore has the other cases' chunks as distractors.
- Each case's query runs through the production `hybridSearch` (k = `AI_ASK_SOURCE_LIMIT` = 6) in a
  real tenant transaction, and the production `assessGrounding` decides from the hits that came
  back.
- Refusal correctness and retrieval recall are scored as in `scoring.ts`. Groundedness scores the
  golden answer against the chunks actually retrieved, only for cases the gate answered. Citation
  accuracy depends on model output, not retrieval, and stays component-level.
- Two configurations run. **lexical** is production per
  [ADR-020](../adr/0020-lexical-only-retrieval.md). **mock-hybrid** is the configuration before
  ADR-020: content-hash mock vectors, the same ones the ingestion worker writes.

```bash
cd apps/api
TEST_DATABASE_URL=postgres://studafy_test:studafy_test@127.0.0.1:54329/postgres bun run test:ai-eval
```

```
RAG retrieval eval — lexical (k=6, live PostgreSQL)
Case                         Expect  Got     Refuse  Recall  Ground  Rank
grounded-photosynthesis      answer  answer   1.00   0.50   0.50    1
grounded-mitosis             answer  refuse   0.00   0.00    —      —
grounded-newton              answer  answer   1.00   0.50   0.50    1
grounded-emancipation        answer  answer   1.00   0.50   0.50    1
grounded-molarity            answer  answer   1.00   0.50   1.00    1
grounded-water-cycle         answer  refuse   0.00   0.00    —      —
grounded-electrolysis        answer  refuse   0.00   0.00    —      —
grounded-plate-tectonics     answer  answer   1.00   1.00   1.00    1
refusal-semantic-only        refuse  refuse   1.00    —      —      —
refusal-below-threshold      refuse  answer   0.00    —      —      —
refusal-weak-hits            refuse  refuse   1.00    —      —      —
refusal-tangential           refuse  refuse   1.00    —      —      —
citation-out-of-range        answer  refuse   0.00   0.00    —      —
citation-invented-id         answer  refuse   0.00   0.00    —      —
retrieval-partial-recall     answer  answer   1.00   0.50   1.00    1
refusal correctness 0.600 | recall@6 0.318 | groundedness (answered) 0.750 | answered 6/11
```

| Configuration          | Refusal correctness | Recall@6 | Groundedness (answered) | Answered | vs NFR-11 (≥ 0.95 / ≥ 0.95) |
| ---------------------- | ------------------- | -------- | ----------------------- | -------- | --------------------------- |
| **lexical** (prod)     | **0.600**           | 0.318    | **0.750**               | 6/11     | **Not met**                 |
| mock-hybrid (baseline) | 0.600               | 0.409    | 0.750                   | 6/11     | Not met                     |

**Result: NFR-11 is not met on live retrieval in either configuration.** Dropping the mock vectors
made no difference to quality: verdicts match on 14 of 15 cases, and the mock's recall edge came
from two chunks it happened to rank. The shortfall comes from the keyword leg:

- **AND semantics.** `websearch_to_tsquery` requires every content word of the question. "How does
  electrolysis work?" fails on _work_, "What happens during mitosis?" on _happen_, and the
  water-cycle question on _main stage_. That accounts for the 5 wrongly refused answer-cases and
  the low recall.
- **Half-supported answers.** Where a case was answered, the second relevant chunk usually lacked
  one of the words, so only half of each two-sentence golden answer is supported by the sources the
  model would see (groundedness 0.50 on those cases).
- **`refusal-below-threshold`** ("What is the capital of France?") is answered, because "Paris is …
  France and a major European capital" contains both words. The golden case's expected refusal
  is debatable for a real corpus. It is recorded as is, not edited to pass.

**CI gate.** The suite runs in CI wherever `TEST_DATABASE_URL` is set. It gates lexical retrieval
on the measured floor (refusal 0.60, groundedness 0.75, recall 0.318) as a ratchet, so retrieval
cannot get worse without notice. Raise the floor with each improvement and replace it with the
NFR-11 targets once they hold. The recommended next step is in ADR-020 § Consequences: a keyword
leg that does not require every word (an OR query ranked by `ts_rank_cd`) plus a gate on how much
of the question the best chunk covers.

## CI status — corrected finding

An earlier draft of this pack's evidence table stated `test:ai-eval` was not wired into any CI
workflow, based on `grep`-ing `.github/workflows/*.yml` for the literal string `ai-eval` and
finding no explicit step. That check was insufficient and the conclusion was wrong: `apps/api`'s
`test` script is `bun test` with no path argument, and Bun's default test runner recursively
discovers every `*.test.ts` file under the package — including `tests/ai-eval/harness.test.ts` —
with no separate opt-in required. Confirmed directly:

```bash
cd apps/api && bun test --timeout 30000 2>&1 | grep -i "ai-eval\|RAG evaluation"
# tests\ai-eval\harness.test.ts:
```

`turbo run test` (invoked by `CI / quality`'s "Unit tests with coverage" step whenever
`@studafy/api` is in that PR's affected-package filter) calls that same `test` script, so this
harness already runs — and already gates — every PR that touches `@studafy/api` or anything it
depends on. There is no CI gap here. This correction stands as the honest record; the fix was to
verify by actually running the command rather than trusting a single grep pattern for a workflow
step name.

## Known gaps

- **No live/production measurement.** This is an offline eval against a fixed 15-case golden set,
  not a measurement against real student traffic — the same "no environment has ever taken real
  traffic" gap every other NFR in this repo has (see
  [`nfr-verification-evidence-pack.md`](../runbooks/launch/nfr-verification-evidence-pack.md)).
- **15 cases is not comprehensive.** It covers every metric dimension at least once, deliberately
  small so it stays fast and hand-auditable. A real production failure mode not shaped like any of
  the 15 (a new material type, a new refusal reason) won't be caught until someone adds a case for
  it.
- **Live retrieval is below target** (2026-11-03 run above). The component run passes, but its
  fixtures carry RRF scores that real retrieval cannot produce. Treat the live-retrieval numbers as
  the true state of NFR-11.
- **Retrieval recall has no CI threshold**, unlike the other three metrics — it's scored and
  printed per-case but nothing in `harness.test.ts` currently asserts a minimum. Worth a follow-up
  if recall on the one edge case here (0.67) turns out to generalize.
