import { useFormatters } from "../../../lib/i18n";

/**
 * A currency's decimal places (ISO 4217: USD 2, KWD 3, JPY 0), for amounts the API sends without
 * their `minorUnit` (the calculator, receipts) and for parsing what is typed. `app.currencies`
 * holds the ISO values, so the two agree; an unknown code falls back to 2.
 */
export function currencyMinorUnit(currencyCode: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Money in the license console. The API speaks whole minor units of each currency (cents, fils);
 * these turn them into the user's locale for display, and parse what the super admin types back
 * into minor units.
 */
export function useMoney() {
  const { formatCurrency } = useFormatters();
  return (amountMinor: number, currencyCode: string, minorUnit = currencyMinorUnit(currencyCode)) =>
    formatCurrency(amountMinor / 10 ** minorUnit, currencyCode);
}

/** "12.50" -> 1250 for a 2-decimal currency; null when it is not a non-negative amount. */
export function toMinor(value: string, minorUnit = 2): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > minorUnit) return null;
  return Number(whole) * 10 ** minorUnit + Number(fraction.padEnd(minorUnit, "0") || 0);
}

/** 1250 -> "12.50": the inverse of {@link toMinor}, for prefilling inputs. */
export function fromMinor(amountMinor: number, minorUnit = 2): string {
  return (amountMinor / 10 ** minorUnit).toFixed(minorUnit);
}

/** Basis points as a percentage: 1000 -> "10%", 1250 -> "12.5%". */
export function bpsToPercent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** "10" or "12.5" (a percentage) -> basis points; null when out of 0-100. */
export function percentToBps(value: string): number | null {
  const n = Number(value.trim());
  if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100);
}

/** Today in UTC as YYYY-MM-DD, the API's date format. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
