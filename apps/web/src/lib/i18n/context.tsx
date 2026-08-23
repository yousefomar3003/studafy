/**
 * React wiring for the locale store: mirrors `lib/auth/context.tsx`'s split between a
 * framework-agnostic store and a thin provider/hook pair.
 *
 * `LocaleProvider` owns two effects: it keeps i18next's active language following the store (so
 * calling `setLocale` — the locale switcher's only job — is the single source of truth), and it
 * keeps `<html lang dir>` following i18next's *actual* active language, which also covers the
 * dev-only pseudo-locale switching straight to `i18next.changeLanguage("qps-ploc")` without going
 * through the store.
 */
import { useEffect, useSyncExternalStore, type PropsWithChildren } from "react";
import { I18nextProvider } from "react-i18next";

import { directionFor, SUPPORTED_LOCALES, type Locale } from "./config";
import { i18next } from "./i18next";
import { localeStore } from "./store";

export function LocaleProvider({ children }: PropsWithChildren) {
  useEffect(() => {
    return localeStore.subscribe(() => {
      void i18next.changeLanguage(localeStore.getLocale());
    });
  }, []);

  useEffect(() => {
    const applyDocumentAttributes = (language: string) => {
      document.documentElement.lang = language;
      document.documentElement.dir = directionFor(language);
    };
    applyDocumentAttributes(i18next.language);
    i18next.on("languageChanged", applyDocumentAttributes);
    return () => {
      i18next.off("languageChanged", applyDocumentAttributes);
    };
  }, []);

  return <I18nextProvider i18n={i18next}>{children}</I18nextProvider>;
}

export interface LocaleState {
  readonly locale: Locale;
  readonly dir: "ltr" | "rtl";
  readonly setLocale: (locale: Locale) => void;
  readonly supportedLocales: typeof SUPPORTED_LOCALES;
}

/** The user's chosen locale — the persisted one from `store.ts`, never the dev-only pseudo-locale. */
export function useLocale(): LocaleState {
  const locale = useSyncExternalStore(localeStore.subscribe, localeStore.getLocale);
  return {
    locale,
    dir: directionFor(locale),
    setLocale: localeStore.setLocale,
    supportedLocales: SUPPORTED_LOCALES,
  };
}
