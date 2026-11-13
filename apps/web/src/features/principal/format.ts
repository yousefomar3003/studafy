/**
 * Shared `Intl` options for the principal screens, passed to `useFormatters().formatDate` /
 * `formatNumber` so dates and percentages follow the active locale.
 */

/** The same fields `Date#toLocaleString()` shows (numeric date + time with seconds). */
export const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

/** Whole-number percent; pass a 0–1 ratio (e.g. `present_percent / 100`). */
export const WHOLE_PERCENT_OPTIONS: Intl.NumberFormatOptions = {
  style: "percent",
  maximumFractionDigits: 0,
};

/** One-decimal percent ("82.0%"); pass a 0–1 ratio. */
export const ONE_DECIMAL_PERCENT_OPTIONS: Intl.NumberFormatOptions = {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
};
