import ar from "../locales/ar.json";
import en from "../locales/en.json";

import type { ErrorCode } from "@studafy/constants";
import type { MiddlewareHandler } from "hono";

/**
 * Locale middleware: parses the Accept-Language header and stores the locale in the request context.
 * Provides localized error messages based on the parsed locale.
 *
 * Supported locales: en (English), ar (Arabic). Falls back to English if locale not found.
 *
 * @example
 * ```typescript
 * app.use("*", localeMiddleware());
 * const locale = c.get("locale"); // "en" or "ar"
 * const message = getLocalizedMessage("AUTH_INVALID_CREDENTIALS", locale);
 * ```
 */

/** Supported locale codes. */
export type SupportedLocale = "en" | "ar";

/** Translation catalog type. */
type TranslationCatalog = Record<ErrorCode, string>;

/** Loaded translation catalogs. */
const catalogs: Record<SupportedLocale, TranslationCatalog> = {
  en: en as TranslationCatalog,
  ar: ar as TranslationCatalog,
};

/** Default locale when Accept-Language header is missing or unsupported. */
const DEFAULT_LOCALE: SupportedLocale = "en";

/** Regex to parse Accept-Language header values. */
const ACCEPT_LANGUAGE_REGEX = /^([a-z]{2}(?:-[a-zA-Z]{2,})?)(?:;q=(\d+(?:\.\d+)?))?$/;

/**
 * Parse the Accept-Language header and return the best matching supported locale.
 *
 * @param acceptLanguage - The Accept-Language header value (e.g., "ar,en;q=0.9")
 * @returns The best matching supported locale
 *
 * @example
 * ```typescript
 * parseAcceptLanguage("ar,en;q=0.9") // "ar"
 * parseAcceptLanguage("en-US,en;q=0.9") // "en"
 * parseAcceptLanguage("fr-FR,fr;q=0.9") // "en" (fallback)
 * parseAcceptLanguage("") // "en" (fallback)
 * ```
 */
export function parseAcceptLanguage(acceptLanguage: string | undefined): SupportedLocale {
  if (!acceptLanguage || acceptLanguage.trim() === "") {
    return DEFAULT_LOCALE;
  }

  // Split by comma and parse each language tag
  const languages = acceptLanguage
    .split(",")
    .map((lang) => lang.trim())
    .filter((lang) => lang.length > 0);

  // Sort by quality factor (higher first), default to 1.0
  const parsed = languages
    .map((lang) => {
      const match = ACCEPT_LANGUAGE_REGEX.exec(lang);
      if (!match) {
        return null;
      }
      const code = match[1]?.split("-")[0] ?? "";
      const quality = match[2] ? parseFloat(match[2]) : 1.0;
      return { code, quality };
    })
    .filter((item): item is { code: string; quality: number } => item !== null)
    .sort((a, b) => b.quality - a.quality);

  // Find the first supported locale
  for (const { code } of parsed) {
    if (isSupportedLocale(code)) {
      return code;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Check if a locale code is supported.
 */
function isSupportedLocale(code: string): code is SupportedLocale {
  return code in catalogs;
}

/**
 * Get a localized message for an error code.
 *
 * @param code - The error code from ERROR_CODES
 * @param locale - The locale to use (defaults to "en")
 * @returns The localized error message
 */
export function getLocalizedMessage(
  code: ErrorCode,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const catalog = catalogs[locale] ?? catalogs[DEFAULT_LOCALE];
  return catalog[code] ?? catalogs[DEFAULT_LOCALE][code] ?? code;
}

/**
 * Locale middleware: parses Accept-Language header and attaches locale to request context.
 */
export function localeMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const acceptLanguage = c.req.header("Accept-Language");
    const locale = parseAcceptLanguage(acceptLanguage);

    c.set("locale", locale);

    await next();
  };
}

/**
 * Get the Accept-Language header value for forwarding to ERPNext.
 * This preserves the original header value, not the parsed locale.
 *
 * @param acceptLanguage - The original Accept-Language header value
 * @returns The header value to forward, or undefined if not provided
 */
export function getForwardableAcceptLanguage(
  acceptLanguage: string | undefined,
): string | undefined {
  return acceptLanguage;
}
