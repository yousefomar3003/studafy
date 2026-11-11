import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

import { useSeo } from "../../components/Seo";
import { MarkdownContent } from "../../features/help/markdown";
import { useLocale, useTranslation } from "../../lib/i18n";

import { LEGAL_DOCUMENT_PATHS, parseLegalDocument } from "./legal-content";
import { LEGAL_DOCUMENTS } from "./legal-documents";

import type { LegalDocumentId } from "./legal-content";

import "../../features/help/help.css";

const LOCALES = ["en", "ar"] as const;

/**
 * One of Studafy's legal documents (`/privacy`, `/terms`, `/school-agreement`), in the visitor's
 * language. The text is Markdown in `/docs/legal/{en,ar}` (see `legal-documents.ts`); this page only
 * frames it. `?lang=ar` (or `en`) switches the site's language first, so a link written for one
 * language opens in it — the redirects from the old legal.studafy.com pages rely on that.
 *
 * Public, with no `RequireAuth`: both app stores, schools deciding whether to apply, and anyone
 * whose data Studafy holds must be able to read these without an account.
 */
export default function LegalDocumentPage({ document }: { document: LegalDocumentId }) {
  const { t } = useTranslation();
  const { locale, setLocale } = useLocale();
  const [searchParams] = useSearchParams();
  const requested = searchParams.get("lang");

  useEffect(() => {
    if (requested && (LOCALES as readonly string[]).includes(requested) && requested !== locale) {
      setLocale(requested as (typeof LOCALES)[number]);
    }
  }, [requested, locale, setLocale]);

  // eslint-disable-next-line security/detect-object-injection -- `document` is a LegalDocumentId, not user input
  const sources = LEGAL_DOCUMENTS[document];
  const parsed = parseLegalDocument(locale === "ar" ? sources.ar : sources.en);

  useSeo({
    title: parsed.title,
    description: t(`site.legal.descriptions.${document}`),
    // eslint-disable-next-line security/detect-object-injection -- `document` is a LegalDocumentId
    path: LEGAL_DOCUMENT_PATHS[document],
  });

  return (
    <section className="marketing-section">
      <div className="marketing-container marketing-about-body">
        <h1>{parsed.title}</h1>
        <MarkdownContent source={parsed.body} />
      </div>
    </section>
  );
}
