/**
 * What a Tap charge status means for money, in one place.
 *
 * Read by the webhook normalizer (apps/api) and the renewal worker (apps/workers); if they disagreed
 * about whether a status was a failure, a renewal could be retried while its webhook marked the
 * subscription paid.
 */

export type TapChargeOutcome = "paid" | "failed" | "pending" | "unknown";

const PAID: ReadonlySet<string> = new Set(["CAPTURED"]);

const FAILED: ReadonlySet<string> = new Set([
  "ABANDONED",
  "CANCELLED",
  "DECLINED",
  "FAILED",
  "RESTRICTED",
  "TIMEDOUT",
  "VOID",
]);

const PENDING: ReadonlySet<string> = new Set(["INITIATED", "IN_PROGRESS"]);

/** `unknown` for a status Tap may add later: never guessed into paid or failed. */
export function tapChargeOutcome(status: string | undefined): TapChargeOutcome {
  const normalized = status?.toUpperCase() ?? "";
  if (PAID.has(normalized)) return "paid";
  if (FAILED.has(normalized)) return "failed";
  if (PENDING.has(normalized)) return "pending";
  return "unknown";
}
