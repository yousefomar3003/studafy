/**
 * Web i18n and RTL foundation: i18next message catalogs, a persisted locale switcher, and the
 * `<html lang dir>` sync that drives RTL mirroring. See `apps/web/docs/i18n-contribution-guide.md`
 * for how to add a string, add a locale, or run the pseudo-locale.
 *
 * - {@link LocaleProvider} — mounts once in `AppProviders`; owns the i18next↔store↔document sync.
 * - {@link useLocale} — the active locale, its direction, and the setter the switcher calls.
 * - {@link useTranslation} (re-exported from `react-i18next`) — the hook components call for text.
 * - {@link useFormatters} / {@link formatDate} / {@link formatNumber} / {@link formatCurrency} —
 *   locale-aware `Intl` wrappers for dates, numbers, and money.
 * - {@link SUPPORTED_LOCALES} / {@link Locale} / {@link directionFor} — the locale/direction facts
 *   everything else here is built on.
 */
export { LocaleProvider, useLocale } from "./context";
export type { LocaleState } from "./context";

export {
  DEFAULT_LOCALE,
  directionFor,
  isSupportedLocale,
  LOCALE_DIRECTION,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
} from "./config";
export type { Locale } from "./config";

export { formatCurrency, formatDate, formatNumber, useFormatters } from "./format";
export type { Formatters } from "./format";

export { createLocaleStore, localeStore } from "./store";
export type { LocaleStore, LocaleStoreOptions } from "./store";

// Components read translations the same way regardless of which app-level provider mounted i18next.
export { useTranslation } from "react-i18next";
