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
- **Retrieval recall has no CI threshold**, unlike the other three metrics — it's scored and
  printed per-case but nothing in `harness.test.ts` currently asserts a minimum. Worth a follow-up
  if recall on the one edge case here (0.67) turns out to generalize.
