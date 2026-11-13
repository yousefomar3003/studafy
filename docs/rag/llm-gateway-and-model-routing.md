# LLM gateway and model routing (ST-164)

The LLM gateway is the single, quota-metered path from an AI surface to the Anthropic plane. It is
the generate half of the RAG pair that hybrid retrieval (ST-162) is the retrieve half of, and it
rides the same ST-155 entitlement gate and Redis token meter as every other `/api/ai/*` route.

The endpoint is `POST /api/ai/students/{studentId}/generate`. It routes the requested **feature**
through a fixed table to a model **tier**, calls the provider once (the provider owns retries and a
per-school circuit breaker), records the provider-reported token usage in the durable ledger
(`app.ai_usage_meters`, same `upsert_ai_usage_tokens` function the retrieval route uses), and
commits the same tokens against the caller's quota. The response carries the serving model and tier
so a client can say "answered by <model>".

Code: `apps/api/src/modules/ai/llm/{routing,provider}.ts`,
`apps/api/src/modules/ai/routes/gateway-routes.ts`, `apps/api/src/modules/ai/usage/durable.ts`.

## Model routing table

Tier is the abstraction, model is the implementation. The route never names a model — it asks
`resolveAiModel(feature, overrides)` and calls whatever id comes back, so flipping a model is an
environment change, not a code change.

| Feature      | Tier  | Default model               |
| ------------ | ----- | --------------------------- |
| `ask`        | large | `claude-sonnet-4-20250514`  |
| `exam`       | large | `claude-sonnet-4-20250514`  |
| `summary`    | small | `claude-3-5-haiku-20241022` |
| `flashcards` | small | `claude-3-5-haiku-20241022` |

The split is cost over capability: long-form, open-ended answers (Ask AI, exam explanations) get the
reasoning-heavy large tier; short, repetitive generation (summaries, flashcard lists) gets the fast
cheap small tier. **One feature is always one tier** — there is no per-request escape hatch, so a
client cannot spend the school's budget on the expensive model for a cheap surface. A deployment
overrides the defaults with `AI_LLM_SMALL_MODEL` / `AI_LLM_LARGE_MODEL` (see the provider runbook);
a partial map leaves the untouched tier on its catalog default.

The table is exhaustiveness-checked: the config test fails if a feature or tier is added without a
routing row or a catalog entry.

## Cost flow and the reservation math

Mirroring the retrieval route, but with the provider call outside the transaction:

1. The gate has already reserved a hold when the handler runs. The generate path resolves
   `AI_LLM_MAX_RESERVE_TOKENS = 24,000`; every other AI surface keeps the default `1,000`.
2. The provider call runs **outside** the tenant transaction. A generation can take tens of seconds,
   and holding a database connection for it would starve the pool.
3. The provider-reported usage (input + cache creation + cache read + output tokens) is recorded
   durably in `app.ai_usage_meters` inside a short tenant transaction.
4. The same tokens are committed against the reservation.

The reserve size is derived from the request schema's own ceilings. The body caps `prompt` and
`system` at 8,000 characters each — roughly 2,000 tokens each under the codebase's
four-chars-per-token estimate — and `maxTokens` at 16,384 output tokens. Worst case is therefore
2,000 + 2,000 + 16,384 = 20,384; 24,000 covers it with margin. This matters because the meter treats
a commit that exceeds its reservation as a programmer error (`commit out of range`): the reserve
must be a strict upper bound, not a guess.

## Failure taxonomy and the HTTP surface

The provider classifies failures the same way the ERPNext client does, because a retry policy needs
three different answers: a timeout (synthesized 504), a network failure (503), and an HTTP verdict
from the provider (the real status). `isTransientLlmFailure` is the shared predicate for both the
retry loop and the circuit breaker, so they cannot drift: timeouts, network failures, 5xx, and 429
are transient; a 4xx is a verdict from a healthy provider and is never retried.

The route maps that taxonomy onto three distinct error codes:

| Situation                                                     | Status | Code                      | Retry-After |
| ------------------------------------------------------------- | ------ | ------------------------- | ----------- |
| Kill switch off (provider is null)                            | 503    | `AI_LLM_DISABLED`         | —           |
| Provider/network failure (transient, retried then f-ailed)    | 503    | `AI_LLM_UNAVAILABLE`      | 30s         |
| Provider answered but refused the request (non-transient 4xx) | 503    | `AI_LLM_REQUEST_REJECTED` | —           |

`AI_LLM_DISABLED` is deliberately distinct from `AI_LLM_UNAVAILABLE`: the feature is _absent_, not
broken, so a client can hide the surface instead of retrying it. `Retry-After` mirrors the circuit
breaker's default cooldown, so a client that honors it retries around the same time the breaker
lets a probe through.

The breaker is keyed per school (`circuitKey` = school id, Redis keys `cb:ai:<schoolId>:*`), so one
school's provider outage does not fail another's requests.

## Why streaming stays provider-level

`AnthropicProvider.stream()` is a tested SSE surface, but the HTTP route is synchronous. The ST-155
gate releases its quota hold when a handler returns, which would race an SSE body still emitting —
the reservation would settle before the stream finished, and a mid-stream failure would have no hold
left to commit against. The synchronous route keeps the simple, correct lifecycle: reserve → call →
commit actual usage. A future chat route that streams will own that reservation lifecycle itself
rather than ride the gate's finally-block release.

## Zero retention

Zero retention is a workspace-level agreement with the provider, not a per-request header (the one
header some clients send is undocumented and rejected with 400). When `AI_LLM_ZERO_RETENTION=true`,
the provider never sends `metadata.user_id` — the one field the provider retains for abuse
monitoring. See the provider runbook for what this means operationally.
