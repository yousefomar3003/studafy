/**
 * The legal documents' text — the only module that pulls in their raw Markdown.
 *
 * The files live in `/docs/legal/{en,ar}` at the repository root, beside the help articles, and are
 * imported through the `@docs` alias with Vite's `?raw` suffix (see `features/help/articles.ts` for
 * why). Tests replace this module with fixtures: under `bun test` the `?raw` imports cannot load.
 *
 * Each file starts with `# Title` and a `Last updated: YYYY-MM-DD` line; that date is the
 * document's version, recorded when a school accepts the terms and the school agreement.
 */

// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import privacyAr from "@docs/legal/ar/privacy.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import schoolAgreementAr from "@docs/legal/ar/school-agreement.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import termsAr from "@docs/legal/ar/terms.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import privacyEn from "@docs/legal/en/privacy.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import schoolAgreementEn from "@docs/legal/en/school-agreement.md?raw";
// eslint-disable-next-line import-x/no-unresolved -- resolved at build time by Vite's `@docs` alias (see `vite.config.ts`)
import termsEn from "@docs/legal/en/terms.md?raw";

import type { LegalDocumentId, LegalDocumentSources } from "./legal-content";

export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocumentId, LegalDocumentSources>> = {
  privacy: { en: privacyEn, ar: privacyAr },
  terms: { en: termsEn, ar: termsAr },
  "school-agreement": { en: schoolAgreementEn, ar: schoolAgreementAr },
};
