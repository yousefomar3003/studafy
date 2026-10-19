// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PERMISSIONS, ROLE_PERMISSIONS } from "./permissions";
import { ROLES } from "./roles";

describe("PERMISSIONS", () => {
  test("every permission value is unique", () => {
    const values = Object.values(PERMISSIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every permission maps to at least one role", () => {
    const coveredPermissions = new Set(Object.values(ROLE_PERMISSIONS).flat());

    for (const permission of Object.values(PERMISSIONS)) {
      expect(coveredPermissions.has(permission)).toBe(true);
    }
  });
});

describe("ROLE_PERMISSIONS", () => {
  test("defines an entry for every role", () => {
    for (const role of Object.values(ROLES)) {
      // eslint-disable-next-line security/detect-object-injection -- `role` is drawn only from the fixed ROLES enum, never external input
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
    }
  });

  test("SUPER_ADMIN holds every permission", () => {
    const superAdminPermissions = new Set(ROLE_PERMISSIONS[ROLES.SUPER_ADMIN]);

    for (const permission of Object.values(PERMISSIONS)) {
      expect(superAdminPermissions.has(permission)).toBe(true);
    }
  });

  test("no role is assigned an unknown permission", () => {
    const knownPermissions = new Set(Object.values(PERMISSIONS));

    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(knownPermissions.has(permission)).toBe(true);
      }
    }
  });

  function rolesHolding(permission: string): string[] {
    return Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => (permissions as readonly string[]).includes(permission))
      .map(([role]) => role)
      .sort();
  }

  // Teachers read attendance reports for their own classes (row scope narrows them); exporting stays
  // with school leadership and the attendance office.
  test("attendance report read and export are held by the expected roles", () => {
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_REPORT_READ)).toEqual(
      [
        ROLES.ATTENDANCE_OFFICER,
        ROLES.INSTRUCTOR,
        ROLES.ORG_ADMIN,
        ROLES.PRINCIPAL,
        ROLES.SUPER_ADMIN,
      ].sort(),
    );
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_REPORT_EXPORT)).toEqual(
      [ROLES.ATTENDANCE_OFFICER, ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  // Registers are taken by the attendance office and by teachers (row scope keeps a teacher to their
  // own classes); corrections stay with the office and the principal. SUPER_ADMIN holds every
  // permission by design.
  test("the attendance officer and teachers take registers", () => {
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_RECORD_CREATE)).toEqual(
      [ROLES.ATTENDANCE_OFFICER, ROLES.INSTRUCTOR, ROLES.SUPER_ADMIN].sort(),
    );
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_RECORD_CORRECT)).toEqual(
      [ROLES.ATTENDANCE_OFFICER, ROLES.PRINCIPAL, ROLES.SUPER_ADMIN].sort(),
    );
  });

  test("admin, principal, teacher and attendance officer get the attendance dashboard", () => {
    expect(rolesHolding(PERMISSIONS.ATTENDANCE_DASHBOARD_VIEW)).toEqual(
      [
        ROLES.ATTENDANCE_OFFICER,
        ROLES.INSTRUCTOR,
        ROLES.ORG_ADMIN,
        ROLES.PRINCIPAL,
        ROLES.SUPER_ADMIN,
      ].sort(),
    );
  });
});
