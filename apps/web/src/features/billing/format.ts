import { formatCurrency, formatDate } from "../../lib/i18n";

import type { Locale } from "../../lib/i18n";

/**
 * Formats a minor-unit amount (cents) in the given ISO currency for the active locale — whole
 * amounts drop the decimals. Shared by the marketing pricing page and the billing screens so plan
 * prices and invoice amounts render the same way everywhere.
 */
export function formatMinorAmount(
  amountMinor: number,
  currencyCode: string,
  locale: Locale,
): string {
  try {
    return formatCurrency(amountMinor / 100, currencyCode, locale, {
      minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    });
  } catch {
    // An unrecognized ISO currency code would throw inside Intl.NumberFormat; fall back to a plain
    // number rather than letting the whole page crash on bad reference data.
    return `${(amountMinor / 100).toFixed(2)} ${currencyCode}`;
  }
}

/**
 * Formats an API ISO timestamp as a locale date. A missing or unparseable value renders as an
 * empty string instead of throwing — `Intl.DateTimeFormat#format` rejects an invalid `Date`, where
 * the old `toLocaleDateString()` call merely printed "Invalid Date".
 */
export function formatIsoDate(iso: string | null | undefined, locale: Locale): string {
  const date = new Date(iso ?? Number.NaN);
  return Number.isNaN(date.getTime()) ? "" : formatDate(date, locale);
}
