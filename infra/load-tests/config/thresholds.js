// NFR-01/02 threshold wiring.
//
// Honesty note: this repo has exactly one formalized NFR document,
// docs/security/NFR-05_cross_tenant_isolation.md. NFR-01 and NFR-02 are referenced by this ticket
// (ST-248) but no doc for either exists anywhere in this repo (checked: `docs/`, `.sisyphus/`,
// `.opencode/`) — they live only in whatever external tracker filed this ticket, and this suite's
// author does not have access to it. The numbers below are therefore a *proposed default*, not a
// transcription of an authoritative target: NFR-01 read as "API latency budget" and NFR-02 read as
// "error-rate / availability budget", set to values defensible for a school-SIS write/read path
// (see docs/testing/load-test-scenarios.md's "Threshold rationale" section for the reasoning per
// endpoint). Every number is overridable by environment variable specifically so that whoever holds
// the real NFR-01/02 document can point this suite at the real targets without editing a script —
// that env-var seam is the actual "wired to NFR targets" contract this ticket asks for; the values
// below are the fallback when no one has done that yet.
//
// k6 fails the run (non-zero exit) when any threshold breaches — that failure *is* "scenarios pass
// NFR-01/02 thresholds" for the acceptance criteria, once real numbers are dropped in here.

function envNumber(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be numeric, got "${raw}"`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// NFR-01 — API latency budget (proposed default; see honesty note above)
// ---------------------------------------------------------------------------
export const NFR_01_LATENCY_MS = {
  // Synchronous tenant-scoped writes/reads that do the real work inline (attendance, published
  // grades on a cache miss). 800/1500 mirrors the kind of budget JWT_verification_architecture.md
  // and the benchmark suites in apps/api/tests/benchmark hold individual middleware layers to,
  // scaled up for a full request that also does I/O.
  p95Standard: envNumber("NFR01_P95_MS", 800),
  p99Standard: envNumber("NFR01_P99_MS", 1500),
  // Redis-cache-hit reads (published grades on the hot path) should be far tighter — this is the
  // number the results-day scenario actually spends most of its time inside.
  p95Cached: envNumber("NFR01_P95_CACHED_MS", 300),
  // The AI ask stream is a different budget entirely: what matters is time-to-first-token
  // (perceived responsiveness), not time-to-fully-answered (which is provider-bound and can
  // legitimately run tens of seconds). See ai-ask-concurrency.js.
  p95AiFirstByte: envNumber("NFR01_P95_AI_TTFB_MS", 3000),
  p95AiFullTurn: envNumber("NFR01_P95_AI_FULL_TURN_MS", 20000),
};

// ---------------------------------------------------------------------------
// NFR-02 — error-rate / availability budget (proposed default; see honesty note above)
// ---------------------------------------------------------------------------
export const NFR_02_ERROR_RATE = {
  // Fraction of requests k6 counts as failed (`http_req_failed`) a scenario may exceed before it's
  // a real problem rather than noise. Business-logic 4xx that a well-behaved client can trigger
  // deliberately (e.g. AI grounding refusals) are excluded at the check level in each scenario,
  // not folded into this budget — see each scenario's own `check()` calls.
  maxFailedRate: envNumber("NFR02_MAX_FAILED_RATE", 0.01),
  // AI is allowed a looser budget: it depends on a third-party LLM provider and a circuit breaker
  // that is *supposed* to shed load under provider degradation (ai/llm/routing.ts) — a 503 from an
  // open circuit is the system working as designed, not a defect this suite should fail the build
  // over at the same bar as an internal 500.
  maxFailedRateAi: envNumber("NFR02_MAX_FAILED_RATE_AI", 0.03),
};

/** Standard synchronous-endpoint thresholds, tagged to one `endpoint` value. */
export function standardEndpointThresholds(endpoint) {
  return {
    [`http_req_duration{endpoint:${endpoint}}`]: [
      `p(95)<${NFR_01_LATENCY_MS.p95Standard}`,
      `p(99)<${NFR_01_LATENCY_MS.p99Standard}`,
    ],
  };
}

/** Cache-hit-dominated read-endpoint thresholds, tagged to one `endpoint` value. */
export function cachedEndpointThresholds(endpoint) {
  return {
    [`http_req_duration{endpoint:${endpoint}}`]: [`p(95)<${NFR_01_LATENCY_MS.p95Cached}`],
  };
}

/**
 * AI ask thresholds, tagged to one `endpoint` value. `http_req_waiting` is k6's built-in
 * time-to-first-byte metric — for a streamed SSE response that approximates time-to-first-token
 * (the `sources` event), which is what NFR-01's `p95AiFirstByte` budget is about.
 * `http_req_duration` covers the whole streamed turn, budgeted far looser since it is provider-bound.
 */
export function aiEndpointThresholds(endpoint) {
  return {
    [`http_req_waiting{endpoint:${endpoint}}`]: [`p(95)<${NFR_01_LATENCY_MS.p95AiFirstByte}`],
    [`http_req_duration{endpoint:${endpoint}}`]: [`p(95)<${NFR_01_LATENCY_MS.p95AiFullTurn}`],
  };
}
