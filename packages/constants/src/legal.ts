/**
 * The current versions of Studafy's legal documents: each is the `Last updated: YYYY-MM-DD` date at
 * the top of `/docs/legal/en/<document>.md`.
 *
 * - A school accepts `terms` and `schoolAgreement` when it applies; the versions are stored on the
 *   application.
 * - Every user accepts `terms` and confirms they have read `privacy` before they can use Studafy;
 *   the versions are stored on their user row. Changing either date asks every user again at their
 *   next sign-in (the `legal_acceptance_pending` access-token claim).
 *
 * Change a date here in the same commit as the document; the web test
 * `routes/legal/legal-versions.test.ts` fails while the two disagree. Schools already on Studafy
 * must be told of a material change before it binds them (the notice clauses in the terms and the
 * school agreement).
 */
export const LEGAL_DOCUMENT_VERSIONS = {
  terms: "2026-11-11",
  privacy: "2026-11-11",
  schoolAgreement: "2026-11-11",
} as const;
