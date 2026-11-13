/**
 * Money presentation for the finance gateway (ST-119).
 *
 * ERPNext returns decimal amounts; this app stores minor units as `bigint`, the convention
 * `app.invoice_cache` and `app.fee_schedule_cache` set in migration 000015. Converting between the
 * two needs the currency's exponent, and **the exponent is not always 2**.
 *
 * That is the whole reason this module exists rather than a `* 100` somewhere. JOD — the currency
 * this product is built for — is seeded in migration 000005 with `minor_unit = 3`: one dinar is
 * 1000 fils. A hardcoded two-decimal assumption silently divides Jordanian money by ten, and does
 * it quietly enough to reach a fee invoice. `app.currencies` already knows the right answer, so
 * this reads it rather than restating it.
 */

import type { TransactionSql } from "postgres";

export interface CurrencyRef {
  id: string;
  code: string;
  minorUnit: number;
}

/**
 * Look up a currency by ISO code. `app.currencies` is a global table with no `school_id`, so this
 * needs no tenant predicate — but it still runs on the tenant transaction so it shares the
 * connection and the RLS role.
 */
export async function getCurrencyByCode(
  tx: TransactionSql,
  code: string,
): Promise<CurrencyRef | undefined> {
  const [row] = await tx<{ id: string; code: string; minor_unit: number }[]>`
    SELECT id, code, minor_unit
    FROM app.currencies
    WHERE code = ${code.toUpperCase()} AND is_active = true
  `;
  if (!row) return undefined;
  return { id: row.id, code: row.code, minorUnit: row.minor_unit };
}

/**
 * Decimal amount -> minor units.
 *
 * Rounds half-away-from-zero at the currency's own precision. The rounding is deliberate and
 * happens *after* scaling: `Math.round(12.345 * 1000)` is exact where `12.345 * 1000` alone is
 * subject to binary floating-point drift.
 */
export function toMinorUnits(amount: number, minorUnit: number): bigint {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`Cannot convert non-finite amount to minor units: ${amount}`);
  }
  const scaled = amount * 10 ** minorUnit;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return BigInt(rounded);
}

/** Minor units -> decimal amount. */
export function fromMinorUnits(minor: bigint, minorUnit: number): number {
  return Number(minor) / 10 ** minorUnit;
}

/**
 * Presentation string for the API response, e.g. `12.345` for JOD.
 *
 * Formatted from the integer directly rather than via a float, so a large amount cannot lose
 * precision on its way to the client. The currency code is returned alongside as its own field
 * rather than concatenated, because placement differs between Arabic and English and that is the
 * client's decision to make.
 */
export function formatMinorUnits(minor: bigint, minorUnit: number): string {
  if (minorUnit === 0) return minor.toString();

  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(minorUnit + 1, "0");
  const whole = digits.slice(0, digits.length - minorUnit);
  const fraction = digits.slice(digits.length - minorUnit);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
