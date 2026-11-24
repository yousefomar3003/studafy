import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { I18nextProvider } from "react-i18next";

import { loadCatalogAreasIn, useTranslation } from "../../../lib/i18n";

import type { ReactNode } from "react";

/**
 * Arabic + English documents (000264). An issued report card, certificate or transcript may carry
 * the language the school issued it in:
 *
 * - none (documents issued before, or a school that leaves it to the reader): rendered in the
 *   reader's own language, exactly as before; the Arabic names are used when the reader is in
 *   Arabic and the document has them;
 * - `en` or `ar`: rendered in that language whatever the reader's, right to left for Arabic;
 * - `bilingual`: every label in English and Arabic, and both spellings of every name.
 *
 * {@link DocumentLanguageScope} wraps a document: for `en` and `ar` it gives everything inside a
 * translation instance fixed to that language (so shared pieces such as the result formats follow
 * too); {@link useDocumentText} gives the document its labels, names and direction.
 */

export type DocumentLanguage = "en" | "ar" | "bilingual";

export type DocumentLabel = (key: string, options?: Record<string, unknown>) => string;

export interface DocumentText {
  /** The issued language; null when the document follows the reader. */
  language: DocumentLanguage | null;
  /** A label in the document's language; both, joined, on a bilingual document. */
  label: DocumentLabel;
  /** A name in the document's language: the Arabic one where wanted and present, else English. */
  name: (en: string, ar: string | null | undefined) => string;
  /** For the document root: right to left for Arabic, inherited otherwise. */
  dir: "rtl" | "ltr" | undefined;
  lang: string | undefined;
}

const BILINGUAL_SEPARATOR = " / ";

interface ScopeValue {
  language: DocumentLanguage | null;
  english: DocumentLabel;
  arabic: DocumentLabel;
}

const ScopeContext = createContext<ScopeValue | null>(null);

/** An unknown value from a newer server degrades to "follow the reader", never to an error. */
export function documentLanguageOf(value: unknown): DocumentLanguage | null {
  return value === "en" || value === "ar" || value === "bilingual" ? value : null;
}

export function DocumentLanguageScope({
  language: raw,
  children,
}: {
  language: unknown;
  children: ReactNode;
}) {
  const language = documentLanguageOf(raw);
  const { i18n } = useTranslation();
  // The other language's catalog is fetched on demand; render at once (falling back to English)
  // and again when it is there.
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    if (language === null) return;
    let live = true;
    void loadCatalogAreasIn(["en", "ar"], ["academicGrading"]).then(() => {
      if (live) setLoaded((count) => count + 1);
    });
    return () => {
      live = false;
    };
  }, [language]);

  const fixed = useMemo(
    () => (language === "en" || language === "ar" ? i18n.cloneInstance({ lng: language }) : null),
    // `loaded` makes a fresh instance once the catalog arrives, so every consumer re-renders.
    [i18n, language, loaded],
  );
  const value = useMemo<ScopeValue>(
    () => ({
      language,
      english: i18n.getFixedT("en") as DocumentLabel,
      arabic: i18n.getFixedT("ar") as DocumentLabel,
    }),
    [i18n, language, loaded],
  );

  const scoped = <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
  return fixed ? <I18nextProvider i18n={fixed}>{scoped}</I18nextProvider> : scoped;
}

/** Pure: the name a document shows, for its language and the reader's. */
export function documentName(
  language: DocumentLanguage | null,
  readerLanguage: string,
  en: string,
  ar: string | null | undefined,
): string {
  const arabic = ar?.trim() ? ar : null;
  switch (language) {
    case "en":
      return en;
    case "ar":
      return arabic ?? en;
    case "bilingual":
      return arabic && arabic !== en ? `${en}${BILINGUAL_SEPARATOR}${arabic}` : en;
    default:
      return readerLanguage.startsWith("ar") && arabic ? arabic : en;
  }
}

/** Pure: a bilingual label from its two translations (one when they are the same). */
export function bilingualLabel(english: string, arabic: string): string {
  return english === arabic ? english : `${english}${BILINGUAL_SEPARATOR}${arabic}`;
}

/**
 * A name interpolated into a label, in both spellings: a bilingual document puts the English one
 * in the English half and the Arabic one in the Arabic half.
 */
export interface LocalizedName {
  en: string;
  ar?: string | null;
}

export function localized(en: string, ar: string | null | undefined): LocalizedName {
  return { en, ar };
}

function isLocalizedName(value: unknown): value is LocalizedName {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { en?: unknown }).en === "string"
  );
}

/** Interpolation values with every {@link LocalizedName} resolved by `pick`. */
function resolveNames(
  options: Record<string, unknown> | undefined,
  pick: (name: LocalizedName) => string,
): Record<string, unknown> | undefined {
  if (!options) return options;
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [
      key,
      isLocalizedName(value) ? pick(value) : value,
    ]),
  );
}

export function useDocumentText(): DocumentText {
  const scope = useContext(ScopeContext);
  const { t, i18n } = useTranslation();
  const language = scope?.language ?? null;
  return useMemo<DocumentText>(() => {
    const label: DocumentLabel =
      language === "bilingual" && scope
        ? (key, options) =>
            bilingualLabel(
              String(
                scope.english(
                  key,
                  resolveNames(options, (name) => name.en),
                ),
              ),
              String(
                scope.arabic(
                  key,
                  resolveNames(options, (name) => (name.ar?.trim() ? name.ar : name.en)),
                ),
              ),
            )
        : (key, options) =>
            String(
              t(
                key,
                resolveNames(options, (name) =>
                  documentName(language, i18n.language, name.en, name.ar),
                ),
              ),
            );
    return {
      language,
      label,
      name: (en, ar) => documentName(language, i18n.language, en, ar),
      dir: language === "ar" ? "rtl" : language === "en" ? "ltr" : undefined,
      lang: language === "ar" || language === "en" ? language : undefined,
    };
  }, [language, scope, t, i18n.language]);
}

/** A student's full name on a document, in its language. */
export function documentStudentName(
  text: Pick<DocumentText, "name">,
  student: {
    first_name: string;
    last_name: string;
    first_name_ar?: string | null;
    middle_name_ar?: string | null;
    last_name_ar?: string | null;
  },
): string {
  const english = `${student.first_name} ${student.last_name}`.trim();
  const arabic = [student.first_name_ar, student.middle_name_ar, student.last_name_ar]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  return text.name(english, arabic === "" ? null : arabic);
}
