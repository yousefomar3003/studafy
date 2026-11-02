# AI provider outage

Anthropic's API is down or degraded, affecting both AI surfaces in this system: the LLM gateway
(`apps/api/src/modules/ai/llm/provider.ts`) and the exam-generation worker
(`apps/workers/src/queues/exam-generation/`). Every surface that touches the provider has its own
kill switch and failure taxonomy — the outage doesn't "take the system down," but it does take
specific AI-dependent features with it, and there is no single panic button; each surface is
controlled independently. Configuration: `docs/runbooks/anthropic-provider-config.md`.

## Detection

There is no CloudWatch alarm targeting Anthropic's availability today. Detection is the same set of
signals as any other provider outage — the one that arrives first matters:

- **Prometheus (workers)**: `bullmq_job_outcomes_total{outcome="failed"}` on the
  `ai-exam-generation` queue with the logs `exam generation failed; retrying` (transient) or
  `AI provider request failed: <message>` (terminal).
- **Prometheus (api)**: the retry logger in `provider.ts` emits `AI generation failed; retrying`
  with `kind`/`status` on every transient attempt.
- **Redis (api circuit breaker state)**: the circuit breaker is per-school, default closed, trips
  on consecutive failures, opens with a 30-second cooldown (constant in
  `apps/api/src/lib/circuit-breaker.ts`). Check:
  ```
  # From the bastion against the cache DB:
  redis-cli -h <primary> -p 6379 -a <token> --tls DB 0 \
    KEYS cb:ai:* | head          # open state keys, one per school with a tripped circuit
  ```
  A school's circuit in `open` state is a request being answered `AI_LLM_UNAVAILABLE` immediately,
  plus a `Retry-After` header. A spreading pattern (multiple `cb:ai:*` keys) is a global outage.
- **The one reliable signal**: check Anthropic's own status page before triaging — an active
  incident there is the fastest way to confirm "wait, don't diagnose."

## What breaks and what doesn't during an outage

| Surface                     | Fail-close behavior                                 | Kill switch                                                  | Failure shape                                                                                                                                           |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exam generation (worker)    | Session marked `failed`, student sees failure in UI | `ANTHROPIC_API_KEY` absent                                   | Job retried on transient (`timeout`/`network`/5xx/429), 3 attempts then `isFinalAttempt` → `markExamSessionFailed` (no DLQ, the exam row is the record) |
| LLM gateway (api, generate) | 503 `AI_LLM_UNAVAILABLE` + `Retry-After` header     | `ai.llm` feature flag (`AI_LLM_ENABLED=false` default)       | `LlmProviderError` after 3 attempts (200ms base, 2s cap, full jitter); circuit breaker trips per school, fails fast until 30s cooldown                  |
| Retrieval re-ranking        | Stage disabled, raw RRF ranking returned            | `ai.rerank` feature flag (`AI_RERANK_ENABLED=false` default) | Not a provider call in the outage path — the mock cross-encoder is deterministic and local                                                              |
| Rate-limit state cache      | Not affected (Redis, no AI dependency)              | —                                                            | —                                                                                                                                                       |
| Entitlements cache          | Not affected                                        | —                                                            | —                                                                                                                                                       |
| Ingestion (parse/OCR/embed) | Not affected (uses mock embedding, not Anthropic)   | —                                                            | —                                                                                                                                                       |

## Decision points

1. **Provider is genuinely down (status page confirms) → operate the kill switches, don't diagnose.**
   The decision is _which_ kill switch, because the two surfaces have different owners:
   - Exam generation is _worker-owned_. The worker queue's `ANTHROPIC_API_KEY` env var absent = jobs
     fail closed at claim time (`examGenerationWorkerConfig.anthropic === null`).
   - LLM gateway is _api-owned_. `AI_LLM_ENABLED=false` prevents the provider from being
     constructed at all — every request gets `AI_LLM_DISABLED`, which is the correct client-facing
     error (clients can check for it), not an opaque timeout. Additionally, the `ai.llm` feature
     flag is evaluated per request, so a school whose `app.feature_flags` row sets it off answers
     `AI_LLM_DISABLED` even when the provider is constructed.
   - Retrieval re-ranking is _duration-invisible_: `ai.rerank` never makes a provider call (the
     mock cross-encoder is deterministic and local), so an outage does not touch it. Flip it only
     to change the ranking contract, not to shed load.
2. **Provider is flaky (status page green, but failures visible) → let the existing retry/breaker
   triage it; only kill-switch if the breaker stays open across the fleet.** The retry + breaker is
   designed for exactly this: per-school isolation, transient-in-awareness, non-silencing failures.
3. **Is this a deploy regression?** A 4xx on a newly deployed model override (`AI_LLM_SMALL_MODEL`
   / `AI_LLM_LARGE_MODEL`) with a provider status page that's green is an _invalid model id_, not
   an outage — the `AI_LLM_REQUEST_REJECTED` status code (4xx, never retried) and the
   `AI_LLM_MAX_TOKENS` range validate at config time. Verify the model is enabled on your
   deployment before switching kill switches; the provider rejects an unknown model immediately.

> **Caveat — per-tenant overrides beat the env kill switch.** An `app.feature_flags` row that sets
> `ai.llm`/`ai.rerank` on for a school outranks the deployment default for that school (migration
> 000109; see `docs/database/feature-flags-data-model.md`). If such a row exists, the env flip in
> step 1 does _not_ disable that one surface and it will keep calling the provider. Step 1 therefore
> includes: list and clear any `ai.llm` override rows (and strip `ai.rerank` too if you need the
> ranking contract back to RRF-only).

## Procedure

**1. Stop new calls to the provider (the kill switches).**

**LLM gateway** — set `AI_LLM_ENABLED=false` in the API environment variables, deploy (or apply via
`infra/deploy/scripts/deploy.sh api <env> <new-tag>`). The provider is not constructed, and every
generate request returns `503 AI_LLM_DISABLED` — a known, typed error clients can route to UI
fallback. Because a per-tenant override beats the env default, also list and clear any `ai.llm`
override rows:

```sql
-- As studafy_admin against the API database (feature-flags docs, 000109):
SELECT school_id, enabled FROM app.feature_flags WHERE flag_name = 'ai.llm';
DELETE FROM app.feature_flags WHERE flag_name IN ('ai.llm', 'ai.rerank');
```

Clearing a row propagates within the flag cache TTL (10s) on the next evaluation — no deploy needed.

**Exam generation** — the API-side kill switch does not cover this surface. The worker's
`ANTHROPIC_API_KEY` absence is what disables it, so removing the key from the ECS secrets is the
incidental path, _or_ add an explicit env guard (a future ticket; today the worker boots and
processes jobs but fails at claim time when the client is null). **Do not stop the worker to kill
one queue** — it hosts 10+ queues; `registry.ts`'s queue affinity means other jobs must continue.

**2. Drain any failures that accumulated during the window.**

- **Exam sessions**: the `exam_sessions` rows that moved to `failed` during the outage are
  already marked — no DLQ row to drain. If the students need a retry after the provider recovers,
  the API's exam create/resume route must file a _new_ `generate-exam` job (the worker does not
  replay failed sessions).
- **LLM gateway requests**: no job queue, just live HTTP requests that returned 503 with
  `Retry-After` — clients retry when the provider recovers, not when the responder acts. Confirm
  the `Retry-After` header is present (the provider, `provider.ts`'s `LlmProviderError` construction
  for `circuit_open` emits it based on the circuit's cooldown — a missing header is a bug in the
  breaker's cooldown tracking).

**3. Confirm recovery, then re-enable.**

```bash
# Confirm Anthropic status page green + a live probe:
curl -s -o /dev/null -w '%{http_code}' \
  -H 'x-api-key: <key>' -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"claude-3-5-haiku-20241022","max_tokens":5,"messages":[{"role":"user","content":"ping"}]}' \
  https://api.anthropic.com/v1/messages
# 200 = provider healthy; the job/API can be re-enabled.
```

Re-enable in the same order you disabled: LLM gateway first (removes 503s), then exam generation.
Re-dispatch is deliberate, not automatic — neither the LLM gateway nor the worker re-queues what
failed during the window. Leave the issue open with the hit counts for follow-up.

**4. Investigate the provider-side impact (post-mortem, not same-day).** A provider outage that
affects `apps/api` has no durable data-loss story (a retryable 503 is a returned request, not a
committed change). The one exception is exam sessions: an exam session that's `generating` when the
outage starts and the worker fails on attempt 3 will be marked `failed` — a new session must be
created, not retried. That is a teacher/UX follow-up, not a data-plane incident, but it is the
record the incident report should capture.

## Rollback / abort criteria

Abort the procedure at step 1 if the outage is confirmed on Anthropic's status page and you are
about to disable — act on the kill switch immediately rather than investigating first. If the
outage is only a partial surface (one model tier works, the other doesn't) and the worker supports
a different model, switching the model ID (not flipping the kill switch) is a narrower fix — but
confirm the model is enabled on the deployment before landing that change.

## Known gaps

- **No automated health-check probe.** Nothing in this repo pings `https://api.anthropic.com/v1`
  periodically; the `realtime-probe` Lambda is WebSocket-only. A synthetic Anthropic health probe
  on a 1-minute schedule, emitted as a CloudWatch metric or Prometheus gauge, would make "provider
  is up" a concrete, alarmed claim rather than a dashboard observation. Not built by any ticket
  here; natural follow-up.
- **Exam generation's failure path is not DLQ-shaped.** A failed session is marked `failed` on
  `app.exam_sessions`; there is no replay handle or "mark pending and re-enqueue." If the teacher
  wants a retry after the outage, a _new_ session is created via the API — intentional, not
  missing DLQ infrastructure, but it does require the user to act.
- **`apps/workers/src/registry.ts` has no per-queue kill switch.** Disabling exam generation
  requires removing the Anthropic credential (key gone from secrets = client null at claim time);
  there is no `AI_EXAM_GENERATION_ENABLED` flag matching `AI_LLM_ENABLED`. That flag would be
  cleaner but requires a code change alongside the env wiring.
