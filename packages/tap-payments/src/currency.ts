/**
 * ISO 4217 exponents of the currencies Tap settles.
 *
 * Tap takes amounts as decimal major units and formats them to exactly this many places when it
 * computes a webhook `hashstring`, so the exponent is needed both to build a charge and to verify
 * one -- the latter with no database in reach. The values agree with `app.currencies.minor_unit`
 * (000005). JOD, KWD, BHD and OMR have three decimals, and treating them as two divides the amount
 * by ten.
 */
export const TAP_CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  AED: 2,
  BHD: 3,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  JOD: 3,
  KWD: 3,
  OMR: 3,
  QAR: 2,
  SAR: 2,
  USD: 2,
};

/** The currency's exponent, or `null` when Tap does not settle it. */
export function tapCurrencyExponent(currency: string): number | null {
  return TAP_CURRENCY_EXPONENTS[currency.toUpperCase()] ?? null;
}

/** Thrown for an amount or currency no Tap charge could carry. Nothing was sent to Tap. */
export class TapAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TapAmountError";
  }
}

/** Minor units -> the decimal major-unit amount Tap charges, at the currency's own precision. */
export function toTapAmount(amountMinor: number, currency: string): number {
  const exponent = tapCurrencyExponent(currency);
  if (exponent === null) {
    throw new TapAmountError(`Tap does not settle ${currency}`);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TapAmountError("Charge amount must be a positive whole number of minor units");
  }
  return Number((amountMinor / 10 ** exponent).toFixed(exponent));
}

/** The decimal amount Tap reports -> minor units, or `null` for a currency Tap does not settle. */
export function fromTapAmount(amount: number, currency: string): number | null {
  const exponent = tapCurrencyExponent(currency);
  if (exponent === null || !Number.isFinite(amount)) return null;
  return Math.round(amount * 10 ** exponent);
}
