import type { Guide } from "./types";

/**
 * Idempotency guide (ST-269).
 *
 * Sourced from apps/api/src/middleware/idempotency.ts (the generic Redis-backed replay guard) and
 * apps/api/src/app.ts's three `idempotencyMiddleware(...)` mount points — the guide names exactly
 * those three prefixes rather than "financial endpoints" in the abstract, because that is the whole
 * set today and a fourth route added without also mounting the middleware there would leave this
 * page wrong until someone caught it. modules/finance/payments/service.ts and refunds/service.ts
 * cover the durable, payment-specific guard layered on top.
 */
export const idempotencyGuide: Guide = {
  slug: "idempotency",
  navTitle: "Idempotency",
  title: "Idempotency",
  summary:
    "How to retry a POST safely. An Idempotency-Key header makes a retried request return the " +
    "original result instead of repeating its side effect — on the routes that opt in.",
  sections: [
    {
      heading: "Where it applies",
      body: [
        "Idempotency-key handling is mounted on exactly three prefixes today " +
          "(`apps/api/src/app.ts`):",
      ],
      blocks: [
        {
          language: "text",
          code: "/api/finance/*\n/api/imports/*\n/api/attendance/records/batch",
        },
      ],
      // No `body` addendum below every route in these trees necessarily requires the header — see
      // "Optional vs. required" — this section only states where the mechanism is wired up at all.
    },
    {
      heading: "Using it",
      body: [
        "Generate a client-side unique value (a UUID is fine) per **logical** operation, and send " +
          "it on the `POST`:",
      ],
      blocks: [
        {
          language: "http",
          code:
            "POST /api/finance/payments\n" +
            "Idempotency-Key: 6c1f7a3e-2e0a-4b8b-9c1d-1a2b3c4d5e6f\n" +
            "Content-Type: application/json\n\n" +
            "{ … }",
        },
      ],
    },
    {
      heading: "Semantics",
      body: [
        "**First request with a key.** The handler runs normally. If it succeeds (status < 400), " +
          "the response — status, headers, and body — is stored in Redis under that key for 24 " +
          "hours. A failed attempt (400 or above) is never cached: the operation did not durably " +
          "happen (or the failure might be transient), so a retry with the same key re-invokes the " +
          "handler rather than replaying the failure.",
        "**Retry, same key, same body.** The stored response is replayed verbatim — same status, " +
          'same body — without re-running the handler. This is what makes "retry on timeout" safe: ' +
          "a client that never saw the first response (the request succeeded server-side but the " +
          "reply was lost) gets the same result a second call would have produced anyway, not a " +
          "duplicate charge or a duplicate import.",
        "**Retry, same key, different body.** Rejected with 409 before the handler runs — the key " +
          "was already bound to a different request and reusing it for something else is treated as " +
          "a caller error, not silently accepted or silently replayed against the wrong body.",
        "**Concurrent duplicates.** Two requests with the same key in flight at once: the second " +
          "waits for the first to finish and returns its result, rather than both running the " +
          "handler and racing.",
        "**Redis unavailable.** The middleware fails open — every request passes through " +
          "unmodified, with no idempotency guarantee, rather than failing the request. This is a " +
          "deliberate availability trade-off for the general mechanism; the payments-specific guard " +
          "below does not make the same trade.",
      ],
      blocks: [
        {
          language: "text",
          code:
            "409 (no Idempotency-Key-specific code — generic middleware, status-derived) →\n" +
            '    CONFLICT_STATE_MISMATCH: "Idempotency key reused with a different request body"',
          errorCodes: ["CONFLICT_STATE_MISMATCH"],
        },
      ],
    },
    {
      heading: "Payments and refunds: a second, durable guard",
      body: [
        "`POST /api/finance/payments` and `POST /api/finance/refunds` additionally require the " +
          "header — omitting it is rejected outright, not merely left unprotected — and enforce " +
          "idempotency a second way, independent of Redis: a durable row keyed by the idempotency " +
          "key, checked inside the same database transaction that would record the payment. Reusing " +
          "a key there for a different request body surfaces a code specific to that guard rather " +
          "than the generic middleware's status-derived one, and a key whose original request is " +
          "still being processed against the upstream payment gateway answers " +
          "`PAYMENT_IN_PROGRESS`/`REFUND_IN_PROGRESS` — the safe response is to wait and re-read, " +
          "never to retry with a new key, which would risk a second charge.",
      ],
      blocks: [
        {
          language: "text",
          code:
            "400 PAYMENT_IDEMPOTENCY_KEY_REQUIRED / REFUND_IDEMPOTENCY_KEY_REQUIRED\n" +
            "409 CONFLICT_IDEMPOTENCY_KEY_MISMATCH — same key, different body, durable guard\n" +
            "409 PAYMENT_IN_PROGRESS / REFUND_IN_PROGRESS — original request not yet resolved",
          errorCodes: [
            "PAYMENT_IDEMPOTENCY_KEY_REQUIRED",
            "REFUND_IDEMPOTENCY_KEY_REQUIRED",
            "CONFLICT_IDEMPOTENCY_KEY_MISMATCH",
            "PAYMENT_IN_PROGRESS",
            "REFUND_IN_PROGRESS",
          ],
        },
      ],
    },
    {
      heading: "Scope",
      body: [
        "Only `POST` requests are covered — the mechanism only exists to make an operation with a " +
          "side effect safe to retry, and `GET`/`PUT`/`DELETE` on these routes pass through " +
          "untouched regardless of the header. A request without an `Idempotency-Key` header always " +
          "passes through unmodified too: the header is opt-in, not a requirement placed on every " +
          "caller (except where the payments/refunds guard above makes it a hard requirement for " +
          "those two specific routes).",
      ],
    },
  ],
};
