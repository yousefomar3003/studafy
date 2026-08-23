/**
 * Locale-aware date/number formatting over the platform `Intl` APIs — deliberately not a
 * from-scratch formatter. Each function takes the locale explicitly rather than reading it from
 * context, so non-component code (query `select`s, CSV export, table cells built outside React) can
 * format with whatever locale it already has in scope; `useFormatters` below is the component-facing
 * convenience that binds the current locale for you.
 */
import { useLocale } from "./context";

import type { Locale } from "./config";

// `Locale` values ("en", "ar") are already valid BCP-47 tags, so they pass straight into `Intl`.
// Note `ar` renders Arabic-Indic digits (٠١٢) by default — pass `{ numberingSystem: "latn" }` where a
// screen mixes numerals with other LTR data (e.g. IDs) and Western digits read better.

export function formatDate(
  value: Date | number,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatCurrency(
  value: number,
  currencyCode: string,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, {
    ...options,
    style: "currency",
    currency: currencyCode,
  }).format(value);
}

export interface Formatters {
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatCurrency: (
    value: number,
    currencyCode: string,
    options?: Intl.NumberFormatOptions,
  ) => string;
}

/** Component-facing formatters bound to the active locale from `useLocale`. */
export function useFormatters(): Formatters {
  const { locale } = useLocale();
  return {
    formatDate: (value, options) => formatDate(value, locale, options),
    formatNumber: (value, options) => formatNumber(value, locale, options),
    formatCurrency: (value, currencyCode, options) =>
      formatCurrency(value, currencyCode, locale, options),
  };
}
