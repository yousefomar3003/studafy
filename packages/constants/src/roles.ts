/**
 * Fixed set of platform roles. See docs/adr/0002-fixed-roles-authorization.md for why roles
 * are a static, compile-time enumeration rather than a database-driven table.
 */
export const ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ORG_ADMIN: "ORG_ADMIN",
  PRINCIPAL: "PRINCIPAL",
  ATTENDANCE_OFFICER: "ATTENDANCE_OFFICER",
  FINANCE: "FINANCE",
  INSTRUCTOR: "INSTRUCTOR",
  STUDENT: "STUDENT",
  PARENT: "PARENT",
  GUEST: "GUEST",
  SUPPORT_AGENT: "SUPPORT_AGENT",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * Roles that use Studafy only through the mobile app. A session holding nothing but these is
 * refused a web session (`isMobileOnly`); one that also holds a web role — an admin who also
 * teaches — keeps web access through that role.
 */
export const MOBILE_ONLY_ROLES: readonly Role[] = [
  ROLES.STUDENT,
  ROLES.PARENT,
  ROLES.INSTRUCTOR,
  ROLES.ATTENDANCE_OFFICER,
];

/** True when every role held is mobile-only. An empty role set is not "mobile-only". */
export function isMobileOnly(roles: readonly string[]): boolean {
  return (
    roles.length > 0 &&
    roles.every((role) => (MOBILE_ONLY_ROLES as readonly string[]).includes(role))
  );
}
