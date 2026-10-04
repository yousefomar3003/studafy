import { i18next } from "../../lib/i18n/i18next";

// Maps (not plain objects) so a subscription status string can never resolve a prototype member —
// moved here from `admin/tiles/SubscriptionStatusBanner.tsx` so the billing feature (which now owns
// the cancellation and dunning screens that also need this) is the one place that defines what each
// lifecycle status means, rather than each consumer re-deriving it.
/** Translation keys (under `site.billing.status`), resolved with `t()` when a label is rendered. */
const STATUS_LABEL_KEY = new Map<string, string>([
  ["trialing", "site.billing.status.trialing"],
  ["active", "site.billing.status.active"],
  ["past_due", "site.billing.status.past_due"],
  ["grace_period", "site.billing.status.grace_period"],
  ["canceled", "site.billing.status.canceled"],
  ["expired", "site.billing.status.expired"],
  ["closed", "site.billing.status.closed"],
  ["paused", "site.billing.status.paused"],
]);

const STATUS_TONE = new Map<string, "success" | "warning" | "danger">([
  ["trialing", "success"],
  ["active", "success"],
  ["past_due", "warning"],
  ["grace_period", "warning"],
  ["paused", "warning"],
  ["canceled", "danger"],
  ["expired", "danger"],
  ["closed", "danger"],
]);

/**
 * Localized label for a subscription status; an unknown wire value renders as-is. Components pass
 * their hook's `t` so the label follows the active locale; the default reads the shared i18next
 * instance at call time (never at module load), for callers that don't have one in scope.
 */
export function subscriptionStatusLabel(
  status: string,
  t: (key: string) => string = (key) => i18next.t(key),
): string {
  const key = STATUS_LABEL_KEY.get(status);
  return key ? t(key) : status;
}

export function subscriptionStatusTone(status: string): "success" | "warning" | "danger" {
  return STATUS_TONE.get(status) ?? "warning";
}

/** Statuses meaning a failed or missed payment — what the dunning banner watches for. */
export function isDunningStatus(status: string): boolean {
  return status === "past_due" || status === "grace_period";
}

/** Terminal statuses with no active access — the overview page offers a plan picker instead of the
 * usual "manage" actions once the subscription is here. */
export function isEndedStatus(status: string): boolean {
  return status === "canceled" || status === "expired" || status === "closed";
}
