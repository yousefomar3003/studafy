/**
 * Fixed set of platform roles. See docs/adr/0002-fixed-roles-authorization.md for why roles
 * are a static, compile-time enumeration rather than a database-driven table.
 */
export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ORG_ADMIN: "ORG_ADMIN",
  FINANCE: "FINANCE",
  INSTRUCTOR: "INSTRUCTOR",
  TEACHING_ASSISTANT: "TEACHING_ASSISTANT",
  STUDENT: "STUDENT",
  PARENT: "PARENT",
  GUEST: "GUEST",
  SUPPORT_AGENT: "SUPPORT_AGENT",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
