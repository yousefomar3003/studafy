/**
 * Calendar arithmetic for billing periods Studafy computes itself (ST-298).
 *
 * Stripe reports every period on its events; Tap has no subscriptions, so for Tap-billed plans
 * Studafy decides where a period ends -- once when the first charge captures (the Tap normalizer in
 * apps/api) and again at each renewal (the renewal worker in apps/workers). Both must reach the same
 * date from the same start, which is why this lives here and nowhere else.
 */

/** Exactly the values of `app.billing_interval` (000004). */
export type BillingInterval = "monthly" | "yearly";

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "monthly" || value === "yearly";
}

/**
 * `start` plus one interval, in UTC, clamped to the target month's last day.
 *
 * Clamping is the point: naive `setUTCMonth(+1)` sends 31 January to 3 March, silently giving a
 * school three extra days and then drifting every later period. Jan 31 -> Feb 28 (29 in a leap
 * year), Feb 29 + 1 year -> Feb 28. Time of day is preserved.
 */
export function addBillingInterval(start: Date, interval: BillingInterval): Date {
  const months = interval === "monthly" ? 1 : 12;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(start.getUTCDate(), lastDayOfTarget);

  return new Date(
    Date.UTC(
      year,
      month,
      day,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}
