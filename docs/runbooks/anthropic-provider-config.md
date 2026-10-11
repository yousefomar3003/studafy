# Anthropic provider configuration

The provider is the wrapper around the Anthropic Messages API used by the LLM gateway
(`docs/rag/llm-gateway-and-model-routing.md`). It owns the HTTP client shape, the retry loop, the
per-school circuit breaker, and the zero-retention toggle. It talks to one region —
`https://api.anthropic.com/v1` (version `2023-06-01`) — pinned at `claude-haiku-4-5`
(small) / `claude-sonnet-4-20250514` (large) defaults. The small tier moved off
`claude-3-5-haiku-20241022` when Anthropic retired it (2026-02-19); the large tier is still on the
deprecated Claude Sonnet 4 until its token budgets are re-sized for an always-thinking successor
(see `AI_LLM_DEFAULT_SMALL_MODEL` in `config.ts`).

Code: `apps/api/src/modules/ai/llm/provider.ts`, `apps/api/src/modules/ai/llm/routing.ts`,
`apps/api/src/modules/ai/config.ts`.

## Environment variables

| Variable                    | Default                    | Purpose                                                                                                                                                                                                                  |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AI_LLM_ENABLED`            | `false`                    | Kill switch. `false` = the provider is **not constructed**, and every generate request answers `503 AI_LLM_DISABLED`.                                                                                                    |
| `AI_LLM_PROVIDER`           | `anthropic`                | `anthropic` or `openai-compatible` (Together AI and the like). See [OpenAI-compatible providers](#openai-compatible-providers-together-ai).                                                                              |
| `ANTHROPIC_API_KEY`         | —                          | Provider auth for `AI_LLM_PROVIDER=anthropic`. Required when `AI_LLM_ENABLED=true` — the config refinement rejects the mismatch either way (key without the switch, switch without the key).                             |
| `AI_LLM_TIMEOUT_MS`         | `60_000`                   | Per-attempt HTTP timeout (range 1,000–300,000). Long-form large-tier generations (exam answers) can take tens of seconds; the default leaves headroom while staying far under the reverse proxy's 5-minute idle ceiling. |
| `AI_LLM_MAX_ATTEMPTS`       | `3`                        | Total attempts per request (1 initial + retries) over transient failures (timeouts, network failures, 5xx, 429). A 4xx is never retried.                                                                                 |
| `AI_LLM_MAX_TOKENS`         | `4,096`                    | Default output-token ceiling a `generate` call uses when the caller passes no `maxTokens` (range 1–16,384; the route always passes one).                                                                                 |
| `AI_LLM_ZERO_RETENTION`     | `false`                    | When `true`, `metadata.user_id` is never sent — the one field Anthropic retains for abuse monitoring.                                                                                                                    |
| `AI_LLM_SMALL_MODEL`        | `claude-haiku-4-5`         | Overrides the small-tier model id.                                                                                                                                                                                       |
| `AI_LLM_LARGE_MODEL`        | `claude-sonnet-4-20250514` | Overrides the large-tier model id.                                                                                                                                                                                       |
| `AI_LLM_MAX_RESERVE_TOKENS` | `24,000`                   | Quota reservation the generate route asks the gate to hold. See the gateway doc for the math.                                                                                                                            |

The model overrides accept a **partial** map: `AI_LLM_SMALL_MODEL=claude-haiku-4-5`
re-tiers only the small tier, and an unset large tier stays on its catalog default. Set both when a
deployment pins a specific Anthropic release for parity across surfaces.

## OpenAI-compatible providers (Together AI)

Deployed tiers run on **Together AI** (`infra/deploy/environments/<tier>.env`), not Anthropic:

```bash
AI_LLM_ENABLED=true
AI_LLM_PROVIDER=openai-compatible        # default: anthropic
AI_LLM_BASE_URL=https://api.together.xyz/v1
AI_LLM_API_KEY=<Together AI key>         # api AND workers app secrets
AI_LLM_SMALL_MODEL=Qwen/Qwen3.5-9B       # both required: the defaults are Claude ids
AI_LLM_LARGE_MODEL=Qwen/Qwen3.5-9B
```

With `openai-compatible` the api and the exam-generation worker call `POST <base>/chat/completions`
with a bearer token instead of `POST <base>/messages`; the retry loop, circuit breaker, failure
taxonomy and secret scrubbing are unchanged (`apps/api/src/modules/ai/llm/openai-compatible.ts`).
Differences to know about:

- **Reasoning is switched off** (`reasoning: {enabled: false}`). Qwen 3.5 thinks by default, those
  tokens count against `max_tokens`, and every surface's ceiling was sized for a direct answer. Any
  `<think>` block that still comes back is dropped from the answer.
- **No user identifier is sent**, so `AI_LLM_ZERO_RETENTION` has nothing to omit. Data retention is
  whatever the Together AI account's privacy settings say
  (`docs/compliance/childrens-data-dossier.md`, open item 7).
- **Streamed usage** comes from the last chunk (`stream_options.include_usage`). If a provider never
  reports it, the answer is metered at an estimate of four characters per token rather than zero.
- **Cost figures** on the AI metrics dashboard and the cost report still use Claude prices
  (`AI_COST_*` in `apps/api/src/modules/ai/config.ts`), so they overstate Together AI spend.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` are ignored. Switching back is
  `AI_LLM_PROVIDER=anthropic` plus an Anthropic key; no code change.

Circuit-breaker thresholds have **no env knobs** — they are constants in
`apps/api/src/lib/circuit-breaker.ts` (default cooldown 30s), shared with the ERPNext client. The
generate route's `Retry-After` mirrors that 30s default deliberately. If you change the default,
align `AI_LLM_RETRY_AFTER_SECONDS` in `apps/api/src/modules/ai/config.ts`.

## Kill switch semantics

`AI_LLM_ENABLED=false` is a **configuration**, not a deployment accident. The provider is not
constructed at all, so the gateway is dead-on-arrival and the error is the distinct
`AI_LLM_DISABLED` (503), letting a client hide the AI surfaces rather than retry them. Contrast
`AI_LLM_UNAVAILABLE`, which means the provider exists but is failing. Because the switch gates on
`AI_LLM_ENABLED && ANTHROPIC_API_KEY` (and Redis present), flipping the switch **on** without the
key is a config error, and the environment cannot be enabled but unkeyed.

## Model naming convention

Id vs. deployment name: `ANTHROPIC_API_KEY` names the **Anthropic deployment** (a named credential
bound to a workspace and provisioned region); `AI_LLM_{SMALL,LARGE}_MODEL` name **models**, which
must be enabled for that deployment. A model id that exists on Anthropic but is not enabled on this
deployment surfaces as `AI_LLM_REQUEST_REJECTED` — a 4xx that is never retried and is worth checking
first when a new model override "doesn't work."

## Failure handling

- Attempts use the shared `isTransientLlmFailure` predicate, the same one the circuit breaker uses,
  so policy and protection cannot disagree. Timeouts (synthesized 504), network failures (503),
  5xx, and 429 retry with exponential backoff and full jitter (200ms base, 2s cap); 4xx does not.
- The circuit breaker is **per school** (`cb:ai:<schoolId>:*`), default closed, trips on consecutive
  failures, opens with a 30s cooldown, and half-opens after the cooldown with one probe. A school in
  an outage fails fast (`AI_LLM_UNAVAILABLE` + `Retry-After`) without exhausting the whole
  deployment's timeouts.
- Cache hits are counted: the provider sums `input_tokens` + `cache_creation_input_tokens` +
  `cache_read_input_tokens` into `usage.inputTokens`, so prompt-caching savings show up in the
  durable ledger and in what gets committed against quota.

## Zero retention

`AI_LLM_ZERO_RETENTION=true` must correspond to an Anthropic workspace agreement. The provider only
omits `metadata.user_id` — the field Anthropic uses for abuse monitoring — because that is the one
the agreement governs. It is enforced per-request, so a future caller that builds a request outside
the provider would silently re-enable retention; keep request construction inside the provider.

## Secrets

The key is sent as a **header, never a URL parameter**, so it cannot leak through a logged URL.
Error payloads are run through the audit redactor and then scrubbed for any literal occurrence of
the key itself. The key lives in Secrets Manager, never in committed config, `openapi.json`, or
environment templates. See `docs/runbooks/secrets-conventions.md` for the general policy.
