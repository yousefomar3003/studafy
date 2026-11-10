/**
 * The versions of the legal documents a school accepts when it applies: each is the
 * `Last updated: YYYY-MM-DD` date at the top of `/docs/legal/en/<document>.md`. The API records them
 * on the application, so there is proof of which text the school agreed to.
 *
 * Change a date here in the same commit as the document; the web test
 * `routes/legal/legal-versions.test.ts` fails while the two disagree. A changed document applies to
 * new applications at once; schools already on Studafy must be told before it binds them (see the
 * notice clause in the terms and the school agreement).
 */
export const LEGAL_DOCUMENT_VERSIONS = {
  terms: "2026-11-11",
  schoolAgreement: "2026-11-11",
} as const;
