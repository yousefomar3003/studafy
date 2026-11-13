/**
 * The set of locales the web app ships UI translations for. Kept in lockstep with the API's own
 * `SupportedLocale` (`apps/api/src/middleware/locale.ts`) by convention, not by import — the two
 * apps don't share a package for this, so adding a locale means updating both lists.
 */
export const SUPPORTED_LOCALES = ["en", "ar"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Text direction per locale. The only fact the rest of the RTL foundation is built on. */
export const LOCALE_DIRECTION: Record<Locale, "ltr" | "rtl"> = {
  en: "ltr",
  ar: "rtl",
};

/** Native-script display name, for the locale switcher. Not translated — a language names itself. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

export function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Accepts any i18next language tag, not just `Locale` — `LocaleProvider` also calls this for the
 * dev-only pseudo-locale, which isn't a real, user-selectable locale (see `i18next.ts`). Anything
 * outside `LOCALE_DIRECTION` renders left-to-right.
 */
export function directionFor(language: string): "ltr" | "rtl" {
  // eslint-disable-next-line security/detect-object-injection -- guarded by the isSupportedLocale type guard just above
  return isSupportedLocale(language) ? LOCALE_DIRECTION[language] : "ltr";
}
