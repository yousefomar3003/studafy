/**
 * Pure, clock-injectable seat-reconciliation helpers (ST-136).
 *
 * Nothing here touches a database or Stripe. `seatDriftDirection` decides which way a
 * subscription's billed seat quantity must move; `computeSeatProration` is the test-time oracle
 * for the prorated upgrade charge. It is deliberately NOT the billing authority: the sweep passes
 * Stripe's own invoice-preview amount into the drift report, and this function exists so a test can
 * assert that an independently-computed expectation equals what the preview returned — the
 * "proration matches Stripe invoice preview" acceptance, proven without a network call.
 */

export type SeatDriftDirection = "upgrade" | "downgrade" | "none";

/**
 * Which way the billed quantity must move to match the enrolled-student count.
 *
 * `upgrade` means the school is using more seats than it pays for (charge more now, prorated);
 * `downgrade` means it pays for seats it no longer uses (drop at the next renewal); `none` means
 * the two already agree and nothing changes.
 */
export function seatDriftDirection(
  activeSeatCount: number,
  billedSeatCount: number,
): SeatDriftDirection {
  if (activeSeatCount > billedSeatCount) return "upgrade";
  if (activeSeatCount < billedSeatCount) return "downgrade";
  return "none";
}

export interface SeatProrationParams {
  /** Price of one seat per billing period, in minor units (e.g. 100000 = 1000.00). */
  unitAmountMinor: number;
  /** Start of the current billing period, inclusive. */
  periodStart: Date;
  /** End of the current billing period, exclusive — the renewal instant. */
  periodEnd: Date;
  /** The instant of the reconciliation. */
  now: Date;
  /** Absolute number of seats being added (a positive delta). */
  deltaSeats: number;
}

/**
 * The expected prorated charge for adding seats mid-period.
 *
 * Each added seat is billed for the fraction of the period that remains, per-seat rounded to the
 * cent, then scaled by the seat delta — the same line-item shape Stripe uses for a quantity
 * change. Used only as a test oracle; the sweep reports Stripe's invoice-preview amount instead,
 * so production never reimplements Stripe's proration and the test can still prove the two agree.
 */
export function computeSeatProration(params: SeatProrationParams): number {
  const totalMs = params.periodEnd.getTime() - params.periodStart.getTime();
  if (totalMs <= 0) return 0;

  const remainingMs = params.periodEnd.getTime() - params.now.getTime();
  const fraction = Math.min(1, Math.max(0, remainingMs / totalMs));

  return Math.round(params.unitAmountMinor * fraction) * params.deltaSeats;
}
