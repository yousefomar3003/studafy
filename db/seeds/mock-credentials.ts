// The single source of truth for the demo tenant's mock personas. The people module seeds users,
// user_roles, and mock OAuth identities from this list, and the seeding guide renders the same list as
// the login table, so credentials cannot drift from what was actually seeded.
//
// There is no password store in the schema (see migration 000007): authentication is external OAuth,
// modeled by app.oauth_identities (provider, subject). For local development every persona logs in
// through a mock provider whose subject equals the persona's email, which a dev auth stub can map
// directly. The role enum (000007) has no PARENT value, so parents carry the GUEST role and are related
// to their children through app.parent_child_links (ST-052 decision).

export type MockRole =
  "SUPER_ADMIN" | "ORG_ADMIN" | "INSTRUCTOR" | "TEACHING_ASSISTANT" | "STUDENT" | "GUEST";

export type MockPersonaGroup = "admin" | "teacher" | "student" | "parent";

export interface MockPersona {
  // Stable slug used to wire relationships (parent -> child) without depending on array order.
  readonly key: string;
  readonly group: MockPersonaGroup;
  readonly role: MockRole;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  // Student keys this parent is a guardian of, with the relationship recorded on parent_child_links.
  readonly children?: readonly {
    readonly studentKey: string;
    readonly relationship: MockRelationship;
  }[];
}

export type MockRelationship =
  "mother" | "father" | "guardian" | "step_parent" | "grandparent" | "sibling" | "other";

// The OAuth provider name for all mock identities. Matches app.oauth_identities.provider's
// ^[a-z][a-z0-9_]*$ check.
export const MOCK_OAUTH_PROVIDER = "mock";

// The demo school's email domain. Kept on a .test TLD so no address is ever a real, deliverable inbox.
export const MOCK_EMAIL_DOMAIN = "demo.studafy.test";

export function displayName(persona: MockPersona): string {
  return `${persona.firstName} ${persona.lastName}`;
}

// The OAuth subject a persona authenticates with. Equal to the email for a frictionless dev login.
export function mockSubject(persona: MockPersona): string {
  return persona.email;
}

const STUDENT_KEYS = [
  "student-yara",
  "student-adam",
  "student-nour",
  "student-zaid",
  "student-lina",
  "student-omar",
  "student-huda",
  "student-sami",
] as const;

const students: MockPersona[] = [
  ["student-yara", "Yara", "Khalil"],
  ["student-adam", "Adam", "Fares"],
  ["student-nour", "Nour", "Saleh"],
  ["student-zaid", "Zaid", "Mansour"],
  ["student-lina", "Lina", "Haddad"],
  ["student-omar", "Omar", "Darwish"],
  ["student-huda", "Huda", "Rahman"],
  ["student-sami", "Sami", "Aziz"],
].map(([key, firstName, lastName]) => ({
  key,
  group: "student" as const,
  role: "STUDENT" as const,
  firstName,
  lastName,
  email: `${key.replace("student-", "")}.${lastName.toLowerCase()}@${MOCK_EMAIL_DOMAIN}`,
}));

const parents: MockPersona[] = [
  ["parent-khalil", "Rania", "Khalil", "student-yara", "mother"],
  ["parent-fares", "Bassel", "Fares", "student-adam", "father"],
  ["parent-saleh", "Maha", "Saleh", "student-nour", "mother"],
  ["parent-mansour", "Tariq", "Mansour", "student-zaid", "father"],
  ["parent-haddad", "Dalia", "Haddad", "student-lina", "guardian"],
  ["parent-darwish", "Karim", "Darwish", "student-omar", "father"],
].map(([key, firstName, lastName, studentKey, relationship]) => ({
  key,
  group: "parent" as const,
  role: "GUEST" as const,
  firstName,
  lastName,
  email: `${key.replace("parent-", "")}.parent@${MOCK_EMAIL_DOMAIN}`,
  children: [{ studentKey, relationship: relationship as MockRelationship }],
}));

const staff: MockPersona[] = [
  {
    key: "super-admin",
    group: "admin",
    role: "SUPER_ADMIN",
    firstName: "Sana",
    lastName: "Al-Rashid",
    email: `superadmin@${MOCK_EMAIL_DOMAIN}`,
  },
  {
    key: "org-admin",
    group: "admin",
    role: "ORG_ADMIN",
    firstName: "Omar",
    lastName: "Haddad",
    email: `admin@${MOCK_EMAIL_DOMAIN}`,
  },
  {
    key: "instructor-science",
    group: "teacher",
    role: "INSTRUCTOR",
    firstName: "Layla",
    lastName: "Nasser",
    email: `layla.nasser@${MOCK_EMAIL_DOMAIN}`,
  },
  {
    key: "instructor-math",
    group: "teacher",
    role: "INSTRUCTOR",
    firstName: "Hassan",
    lastName: "Ibrahim",
    email: `hassan.ibrahim@${MOCK_EMAIL_DOMAIN}`,
  },
  {
    key: "instructor-arts",
    group: "teacher",
    role: "INSTRUCTOR",
    firstName: "Mona",
    lastName: "Farouk",
    email: `mona.farouk@${MOCK_EMAIL_DOMAIN}`,
  },
  {
    key: "teaching-assistant",
    group: "teacher",
    role: "TEACHING_ASSISTANT",
    firstName: "Yusuf",
    lastName: "Karim",
    email: `yusuf.karim@${MOCK_EMAIL_DOMAIN}`,
  },
];

export const MOCK_PERSONAS: readonly MockPersona[] = [...staff, ...students, ...parents];

export const MOCK_STUDENT_KEYS: readonly string[] = STUDENT_KEYS;
