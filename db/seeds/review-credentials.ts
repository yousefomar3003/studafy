// The single source of truth for the App Store / Play reviewer tenant's roster and its four logins
// (ST-303). review-tenant.ts seeds exactly this list, and docs/runbooks/app-review-access.md renders
// the same login table, so what reviewers are told cannot drift from what was seeded.
//
// The roster reuses the local demo personas (same keys, names, and relationships) so every shared
// data module seeds the same realistic school, with three differences that make it safe to provision
// in production:
//   - no SUPER_ADMIN: a platform-wide role must never be reachable with a shared password;
//   - parents carry the PARENT role (migration 000043), not the local seed's GUEST;
//   - only the four accounts in REVIEW_LOGINS get a login identity; everyone else is roster-only.
//
// The password is NOT here. It is one deployment secret, REVIEW_LOGIN_PASSWORD, read by the API.
import { MOCK_EMAIL_DOMAIN, MOCK_PERSONAS } from "./mock-credentials";

import type { MockPersona } from "./mock-credentials";

export const REVIEW_TENANT_SLUG = "studafy-review-academy";
export const REVIEW_TENANT_NAME = "Studafy Review Academy";

// The oauth_identities.provider for reviewer logins. Mirrors REVIEW_LOGIN_PROVIDER in
// apps/api/src/modules/auth/services/review-login-service.ts, which authenticates it.
export const REVIEW_LOGIN_PROVIDER = "review";

// A .test TLD (RFC 2606) so no reviewer address is a real, deliverable inbox. The seed also adds every
// address to app.email_suppressions, so the email dispatcher never hands one to SES.
export const REVIEW_EMAIL_DOMAIN = "review.studafy.test";

export type ReviewRole = "Administrator" | "Teacher" | "Parent" | "Student";

export interface ReviewLogin {
  readonly role: ReviewRole;
  readonly personaKey: string;
  readonly email: string;
}

// Yara is enrolled in Science, the class that carries the materials, AI tutor conversations,
// assessments, and notifications; Rania Khalil is her linked parent; Layla Nasser teaches Science.
export const REVIEW_LOGINS: readonly ReviewLogin[] = [
  { role: "Administrator", personaKey: "org-admin", email: `admin@${REVIEW_EMAIL_DOMAIN}` },
  { role: "Teacher", personaKey: "instructor-science", email: `teacher@${REVIEW_EMAIL_DOMAIN}` },
  { role: "Parent", personaKey: "parent-khalil", email: `parent@${REVIEW_EMAIL_DOMAIN}` },
  { role: "Student", personaKey: "student-yara", email: `student@${REVIEW_EMAIL_DOMAIN}` },
];

const loginEmailByKey = new Map(REVIEW_LOGINS.map((login) => [login.personaKey, login.email]));

function toReviewPersona(persona: MockPersona): MockPersona {
  return {
    ...persona,
    role: persona.group === "parent" ? "PARENT" : persona.role,
    email:
      loginEmailByKey.get(persona.key) ??
      persona.email.replace(`@${MOCK_EMAIL_DOMAIN}`, `@${REVIEW_EMAIL_DOMAIN}`),
  };
}

export const REVIEW_PERSONAS: readonly MockPersona[] = MOCK_PERSONAS.filter(
  (persona) => persona.role !== "SUPER_ADMIN",
).map(toReviewPersona);

// The login identity for a review persona: only the four REVIEW_LOGINS accounts have one. The subject
// is the normalized email, which is what the review login route resolves.
export function reviewLoginIdentity(
  persona: MockPersona,
): { provider: string; subject: string } | null {
  return loginEmailByKey.has(persona.key)
    ? { provider: REVIEW_LOGIN_PROVIDER, subject: persona.email.toLowerCase() }
    : null;
}
