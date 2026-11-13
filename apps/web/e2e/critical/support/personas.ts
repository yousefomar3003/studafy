/**
 * The seeded demo-tenant personas the critical-journeys specs sign in as, mirroring
 * `db/seeds/mock-credentials.ts` (the single source of truth — these are copies of that file's
 * emails, not a second definition of who these people are). Every one of them already has a
 * `provider='mock', subject=<email>` row in `app.oauth_identities` (`db/seeds/data/people.ts`), so
 * `login_hint=<email>` on the mock OAuth flow signs them in directly — no password, no real IdP.
 */

export const MOCK_EMAIL_DOMAIN = "demo.studafy.test";

export const PERSONAS = {
  /** ORG_ADMIN — invitations, invoice batches, payment recording, subscription checkout, approvals. */
  orgAdmin: "admin@demo.studafy.test",
  /** INSTRUCTOR of SCI101-A — opens attendance sessions, enters and submits grades. */
  scienceTeacher: "layla.nasser@demo.studafy.test",
  /** STUDENT with an active AI subscription (db/seeds/data/ai.ts's first four students) — Ask AI. */
  aiStudent: "yara.khalil@demo.studafy.test",
} as const;

/** The Science class both the attendance and grades journeys operate on (db/seeds/data/academics.ts). */
export const SCIENCE_CLASS_CODE = "SCI101-A";

/**
 * The mock OAuth subject/login_hint for any seeded student or parent persona, given their profile
 * name — `db/seeds/mock-credentials.ts`'s `email` formula (`<key-without-prefix>.<lastName>@domain`,
 * lowercased), reproduced here because the grade-workflow journey needs to log in as *whichever*
 * student ends up holding a given draft submission, not a single fixed one — see its own comment.
 */
export function personaEmailFor(firstName: string, lastName: string): string {
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${MOCK_EMAIL_DOMAIN}`;
}
