// The single source of truth for the staging QA tenants' rosters and logins (QA-02,
// docs/testing/qa-plan.md). qa-tenant.ts seeds exactly these lists, qa/ reads the same account table,
// and docs/runbooks/qa-staging-access.md renders it, so what testers are told cannot drift from what
// was seeded.
//
// Three schools, all flagged is_qa_tenant (migration 000183):
//   - a platform school holding only the SUPER_ADMIN, so platform-wide access is tested from a school
//     that is neither of the two under test;
//   - School A and School B, each the full demo roster minus SUPER_ADMIN, so every school role exists
//     twice and cross-tenant probes have a real target on both sides.
// Unlike the reviewer tenant, every QA persona can log in: testing "teacher X cannot see teacher Y's
// class" needs two teachers with sessions, not one.
//
// The password is NOT here. It is one deployment secret, QA_LOGIN_PASSWORD, read by the API, which
// refuses to boot with it set when APP_ENV is production.
import { MOCK_EMAIL_DOMAIN, MOCK_PERSONAS } from "./mock-credentials";

import type { MockPersona, MockRole } from "./mock-credentials";

// The oauth_identities.provider for QA logins. Mirrors QA_LOGIN_PROVIDER in
// apps/api/src/modules/auth/services/qa-login-service.ts, which authenticates it.
export const QA_LOGIN_PROVIDER = "qa";

// The value QA_TENANT_SEED_CONFIRM must carry (guard.ts assertQaSeedAllowed).
export const QA_SEED_CONFIRMATION = "studafy-qa";

export type QaSchoolKey = "platform" | "a" | "b";

export interface QaSchool {
  readonly key: QaSchoolKey;
  readonly slug: string;
  readonly name: string;
  // A .test TLD (RFC 2606): no address is a deliverable inbox, and the seed suppresses them all.
  readonly emailDomain: string;
}

export const QA_SCHOOLS: readonly QaSchool[] = [
  {
    key: "platform",
    slug: "studafy-qa-platform",
    name: "Studafy QA Platform",
    emailDomain: "qa-platform.studafy.test",
  },
  {
    key: "a",
    slug: "studafy-qa-school-a",
    name: "Studafy QA School A",
    emailDomain: "qa-a.studafy.test",
  },
  {
    key: "b",
    slug: "studafy-qa-school-b",
    name: "Studafy QA School B",
    emailDomain: "qa-b.studafy.test",
  },
];

function withDomain(persona: MockPersona, domain: string): MockPersona {
  return { ...persona, email: persona.email.replace(`@${MOCK_EMAIL_DOMAIN}`, `@${domain}`) };
}

export function qaPersonas(school: QaSchool): readonly MockPersona[] {
  const platform = school.key === "platform";
  return MOCK_PERSONAS.filter((persona) => (persona.role === "SUPER_ADMIN") === platform).map(
    (persona) => withDomain(persona, school.emailDomain),
  );
}

// Every QA persona logs in; the subject is the normalized email, which the QA login route resolves.
export function qaLoginIdentity(persona: MockPersona): { provider: string; subject: string } {
  return { provider: QA_LOGIN_PROVIDER, subject: persona.email.toLowerCase() };
}

// The account a tester uses for each role: the first persona holding it. The other personas (two
// more teachers, eight more students, five more parents per school) are there for intra-tenant tests.
export interface QaLogin {
  readonly school: QaSchoolKey;
  readonly role: MockRole;
  readonly personaKey: string;
  readonly email: string;
}

const QA_ROLES: readonly MockRole[] = [
  "SUPER_ADMIN",
  "ORG_ADMIN",
  "PRINCIPAL",
  "INSTRUCTOR",
  "STUDENT",
  "PARENT",
  "FINANCE",
  "ATTENDANCE_OFFICER",
];

export const QA_LOGINS: readonly QaLogin[] = QA_SCHOOLS.flatMap((school) =>
  QA_ROLES.flatMap((role) => {
    const persona = qaPersonas(school).find((candidate) => candidate.role === role);
    return persona
      ? [{ school: school.key, role, personaKey: persona.key, email: persona.email }]
      : [];
  }),
);
