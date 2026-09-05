/// Seeded demo-tenant personas this suite signs in as, mirroring `db/seeds/mock-credentials.ts`
/// (the single source of truth) exactly the way `apps/web/e2e/critical/support/personas.ts` does
/// for the Playwright suite — these are copies of that file's emails, not a second definition of
/// who these people are. Every one already has a `provider='mock', subject=<email>` row in
/// `app.oauth_identities`, so `login_hint=<email>` on the mock OAuth flow signs them in directly.
library;

const mockEmailDomain = 'demo.studafy.test';

abstract final class Personas {
  /// ORG_ADMIN — invitations, and any admin-only step this suite drives via the API.
  static const orgAdmin = 'admin@$mockEmailDomain';

  /// INSTRUCTOR of SCI101-A — opens attendance sessions, enters and submits grades.
  static const scienceTeacher = 'layla.nasser@$mockEmailDomain';

  /// STUDENT with no AI subscription (`db/seeds/data/ai.ts` only pre-subscribes the first four
  /// students — see `db/seeds/mock-credentials.ts`'s `STUDENT_KEYS` order; this one is the fifth)
  /// — the AI hub resolves them to the unsubscribed/upsell state that journey needs.
  static const unsubscribedAiStudent = 'lina.haddad@$mockEmailDomain';
}

/// The mock OAuth `login_hint`/subject for any seeded student or parent persona, given their
/// profile name — mirrors `db/seeds/mock-credentials.ts`'s `email` formula
/// (`<key-without-prefix>.<lastName>@domain`, lowercased). The grade-publish journey needs this:
/// it targets *whichever* student ends up holding a freshly-created draft submission, discovered
/// only after creating it (`db/seeds/data/assessments.ts` pre-seeds every other student's row for
/// the class), not a persona fixed up front — see `apps/web/e2e/critical/support/personas.ts`'s
/// `personaEmailFor`, which this is a direct port of.
String personaEmailFor(String firstName, String lastName) {
  return '${firstName.toLowerCase()}.${lastName.toLowerCase()}@$mockEmailDomain';
}

/// The Science class both the attendance and grades journeys operate on
/// (`db/seeds/data/academics.ts`), mirroring `apps/web/e2e/critical/support/personas.ts`.
const scienceClassCode = 'SCI101-A';
