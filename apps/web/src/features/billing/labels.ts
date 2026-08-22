// Maps (not plain objects) so a subscription status string can never resolve a prototype member —
// moved here from `admin/tiles/SubscriptionStatusBanner.tsx` so the billing feature (which now owns
// the cancellation and dunning screens that also need this) is the one place that defines what each
// lifecycle status means, rather than each consumer re-deriving it.
const STATUS_LABEL = new Map<string, string>([
  ["trialing", "Trialing"],
  ["active", "Active"],
  ["past_due", "Past due"],
  ["grace_period", "Grace period"],
  ["canceled", "Canceled"],
  ["expired", "Expired"],
  ["closed", "Closed"],
  ["paused", "Paused"],
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

export function subscriptionStatusLabel(status: string): string {
  return STATUS_LABEL.get(status) ?? status;
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
