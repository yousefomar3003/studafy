/**
 * Integer money arithmetic. Every amount is a whole number of minor units (cents, fils); products
 * are taken in BigInt so `price x seats x months x basis points` cannot lose precision, and every
 * division rounds once, half up, back to a whole minor unit.
 */

export const BPS_SCALE = 10_000;
export const DAYS_PER_YEAR = 365;
export const MONTHS_PER_YEAR = 12;

/** `numerator / denominator` rounded half up. Both non-negative, denominator positive. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/** `amount x bps / 10_000`, rounded half up to a whole minor unit. */
export function applyBps(amountMinor: bigint, bps: number): bigint {
  return divideHalfUp(amountMinor * BigInt(bps), BigInt(BPS_SCALE));
}

/** Back to a number, refusing anything a JavaScript number cannot hold exactly. */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("amount exceeds the safe integer range");
  }
  return Number(value);
}
