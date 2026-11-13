/**
 * Turning an ERPNext failure into an RFC 9457 problem response, and deciding what it proves.
 *
 * Extracted from `expenses/service.ts` (ST-125) when payments (ST-121) needed the same translation.
 * Two functions with two different jobs, and the split matters:
 *
 *   - {@link translateErpNextError} answers *what to tell the client*. It is the single place where
 *     ERPNext's verdicts become our status codes, which is what keeps the gateway from developing a
 *     second opinion about money. When ERPNext rejects an overpayment, the client sees ERPNext's
 *     reason, not a locally-invented one.
 *   - {@link erpNextDefinitelyDidNotWrite} answers *what we may safely do next*. Only the payment
 *     forwarder needs this, and only because an idempotency reservation must be released or retained
 *     on the answer. Getting it wrong in one direction wedges a key forever; in the other, it double
 *     charges someone.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { ErpNextError } from "../../erpnext/client";

/** The `ERROR_CODES` value to use when ERPNext answers 404 — the caller names its own resource. */
export type NotFoundErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface TranslateOptions {
  /** Code and message for a 404 from ERPNext, e.g. EXPENSE_NOT_FOUND / PAYMENT_NOT_FOUND. */
  notFound?: { code: NotFoundErrorCode; message: string };
}

/**
 * Re-throw an ERPNext failure as a `CodedHttpException`, never returning.
 *
 * A non-`ErpNextError` is rethrown untouched: it is a bug in our code, not a verdict from theirs,
 * and flattening it into a 400 would hide it.
 *
 * The 4xx arm is deliberately a passthrough of ERPNext's own message. ERPNext owns balances,
 * overpayment rejection, and fee allocation; when it refuses a payload, the refusal *is* the
 * business rule, and paraphrasing it here would mean maintaining a copy of rules we do not own.
 */
export function translateErpNextError(error: unknown, options: TranslateOptions = {}): never {
  if (!(error instanceof ErpNextError)) throw error;

  if (error.kind === "circuit_open") {
    throw new CodedHttpException(
      503,
      ERROR_CODES.ERPNEXT_CIRCUIT_OPEN,
      "ERPNext is unreachable; requests are paused while it recovers",
    );
  }
  if (error.kind === "timeout") {
    throw new CodedHttpException(
      504,
      ERROR_CODES.ERPNEXT_TIMEOUT,
      "ERPNext did not respond in time",
    );
  }
  if (error.kind === "network") {
    throw new CodedHttpException(503, ERROR_CODES.ERPNEXT_UNAVAILABLE, "ERPNext is unreachable");
  }

  if (error.status === 404 && options.notFound) {
    throw new CodedHttpException(404, options.notFound.code, options.notFound.message);
  }
  if (error.status >= 500) {
    throw new CodedHttpException(503, ERROR_CODES.ERPNEXT_UNAVAILABLE, "ERPNext is unreachable");
  }

  throw new CodedHttpException(
    error.status === 429 ? 429 : 400,
    error.status === 429 ? ERROR_CODES.RATE_LIMIT_EXCEEDED : ERROR_CODES.VALIDATION_FAILED,
    error.message,
  );
}

/**
 * True when the failure proves ERPNext created nothing.
 *
 * Only two situations qualify, and both are certainties rather than likelihoods:
 *
 *   - `circuit_open` — the breaker refused to call, so no request was ever sent.
 *   - a 4xx (including 429) — ERPNext answered, and answered by rejecting. A rate limiter refuses
 *     before handling, and a validation error refuses before writing.
 *
 * Everything else is *unknown*, not "probably fine". A timeout, a dropped connection, or a 5xx can
 * all mean ERPNext committed a `Payment Entry` and we simply never heard about it. The payment
 * forwarder must therefore keep its idempotency reservation in those cases, so a retry is refused
 * rather than posting a second entry against the same invoice.
 *
 * 429 is grouped with the definite rejections on purpose. It is tempting to treat it as transient —
 * the HTTP client already retried it — but by the time it reaches here the request was refused, and
 * retaining the reservation would leave the key permanently unusable with no payment to show for it.
 */
export function erpNextDefinitelyDidNotWrite(error: unknown): boolean {
  if (!(error instanceof ErpNextError)) return false;
  if (error.kind === "circuit_open") return true;
  if (error.kind !== "http") return false;
  return error.status >= 400 && error.status < 500;
}
