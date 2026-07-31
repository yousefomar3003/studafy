import { AR_TEMPLATES } from "./ar";
import { EN_TEMPLATES } from "./en";

import type { NotificationChannel } from "../types";
import type { LocaleTemplateSet } from "./types";
import type { NotificationType } from "@studafy/constants";

/**
 * The locales notification templates actually exist in.
 *
 * Deliberately narrower than what the platform accepts elsewhere: app.school_settings.locale is
 * constrained only to a BCP-47 shape, and the settings API enumerates six locales. A school set to
 * `fr` has no French templates, so callers narrow through `isTemplateLocale` and fall back rather
 * than indexing this map with whatever the database happened to hold — that would resolve to
 * undefined and throw at the template lookup, one notification at a time, in production only.
 */
export const TEMPLATE_LOCALES = ["en", "ar"] as const;

export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

// Annotated as LocaleTemplateSet, not `typeof EN_TEMPLATES`: both template modules are `as const`,
// so the latter would type the map by English's exact string literals and reject every Arabic one.
const LOCALE_MAP: Record<TemplateLocale, LocaleTemplateSet> = {
  en: EN_TEMPLATES,
  ar: AR_TEMPLATES,
};

/** Narrows an arbitrary locale string to one this module can actually render. */
export function isTemplateLocale(locale: string | null | undefined): locale is TemplateLocale {
  return typeof locale === "string" && locale in LOCALE_MAP;
}

export function renderNotification(
  type: NotificationType,
  channel: NotificationChannel,
  locale: TemplateLocale,
  vars: Record<string, string>,
): string {
  const localeSet = LOCALE_MAP[locale];
  const template = localeSet[type][channel];
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (key in vars) {
      return String(vars[key]);
    }
    return `{${key}}`;
  });
}
